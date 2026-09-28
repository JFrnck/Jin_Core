import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Response as ExpressResponse } from 'express';
import type { OwnerTerminalService } from './owner-terminal.service';
import { TerminalController } from './terminal.controller';
import { TerminalUpstreamError } from './terminal.errors';

function fakeRes() {
  const res = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    written: string[];
    statusCode?: number;
    ended: boolean;
    status: (code: number) => unknown;
    setHeader: (name: string, value: string) => void;
    flushHeaders: () => void;
    write: (chunk: Uint8Array | string) => boolean;
    end: () => void;
  };
  res.headers = {};
  res.written = [];
  res.ended = false;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
  res.flushHeaders = () => undefined;
  res.write = (chunk) => {
    res.written.push(
      typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  };
  res.end = () => {
    res.ended = true;
  };
  return res;
}

function stream(chunks: string[], failWith?: Error): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(encoder.encode(chunks[index++]));
        } else if (failWith) {
          controller.error(failWith);
        } else {
          controller.close();
        }
      },
    }),
  );
}

function controllerWith(exec: ReturnType<typeof vi.fn>) {
  return new TerminalController({ exec } as unknown as OwnerTerminalService);
}

describe('TerminalController.exec', () => {
  it('reenvía el NDJSON tal como llega, con las cabeceras de streaming', async () => {
    const lines = [
      '{"t":"out","d":"hola\\n"}\n',
      '{"t":"exit","code":0,"truncated":false}\n',
    ];
    const exec = vi.fn().mockResolvedValue(stream(lines));
    const res = fakeRes();

    await controllerWith(exec).exec(
      's1',
      { command: 'echo hola' },
      res as unknown as ExpressResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/x-ndjson');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.written.join('')).toBe(lines.join(''));
    expect(res.ended).toBe(true);
  });

  it('un error anterior al primer byte (404, 409, audit) sale como error HTTP, sin abrir el stream', async () => {
    const exec = vi
      .fn()
      .mockRejectedValue(
        new TerminalUpstreamError(
          409,
          'La sesión ya está ejecutando un comando',
        ),
      );
    const res = fakeRes();

    await expect(
      controllerWith(exec).exec(
        's1',
        { command: 'ls' },
        res as unknown as ExpressResponse,
      ),
    ).rejects.toBeInstanceOf(TerminalUpstreamError);
    expect(res.statusCode).toBeUndefined();
    expect(res.written).toEqual([]);
  });

  it('si la conexión con el Executor se corta a mitad, el cliente recibe un evento error y el stream se cierra', async () => {
    const exec = vi
      .fn()
      .mockResolvedValue(
        stream(['{"t":"out","d":"a"}\n'], new Error('socket cerrado')),
      );
    const res = fakeRes();

    await controllerWith(exec).exec(
      's1',
      { command: 'ls' },
      res as unknown as ExpressResponse,
    );

    const last = res.written.at(-1) ?? '';
    expect(JSON.parse(last)).toEqual({ t: 'error', message: 'socket cerrado' });
    expect(res.ended).toBe(true);
  });

  it('cuando el cliente se va, corta la conexión con el Executor', async () => {
    let signal: AbortSignal | undefined;
    const exec = vi
      .fn()
      .mockImplementation((_id: string, _body: unknown, s: AbortSignal) => {
        signal = s;
        return Promise.resolve(stream(['{"t":"out","d":"a"}\n']));
      });
    const res = fakeRes();
    const pending = controllerWith(exec).exec(
      's1',
      { command: 'ls' },
      res as unknown as ExpressResponse,
    );
    res.emit('close');
    await pending;
    expect(signal?.aborted).toBe(true);
  });
});
