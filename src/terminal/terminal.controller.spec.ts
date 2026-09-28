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

describe('TerminalController.preview (vista previa en vivo)', () => {
  function fakeReq(over: Record<string, unknown> = {}) {
    return {
      method: 'GET',
      originalUrl: '/api/terminal/sessions/s1/preview/5173/src/main.js?t=1',
      headers: {
        accept: '*/*',
        cookie: 'sesion=secreta',
        authorization: 'Bearer token-del-owner',
        'x-otro': 'no',
      },
      body: {},
      readableEnded: true,
      ...over,
    } as unknown as import('express').Request;
  }

  function withPreview(previewRequest: ReturnType<typeof vi.fn>) {
    return new TerminalController({
      previewRequest,
    } as unknown as OwnerTerminalService);
  }

  it('reenvía ruta y query tal cual y NO le pasa al servidor las cookies ni el JWT del owner', async () => {
    const previewRequest = vi.fn().mockResolvedValue(
      new Response('console.log(1)', {
        headers: { 'content-type': 'text/javascript' },
      }),
    );
    const res = fakeRes();

    await withPreview(previewRequest).preview(
      's1',
      '5173',
      fakeReq(),
      res as unknown as ExpressResponse,
    );

    const call = previewRequest.mock.calls[0] as [
      string,
      number,
      { pathAndQuery: string; headers: Record<string, string>; method: string },
    ];
    expect(call[0]).toBe('s1');
    expect(call[1]).toBe(5173);
    expect(call[2].pathAndQuery).toBe('/src/main.js?t=1');
    expect(call[2].headers).toEqual({ accept: '*/*' });
    expect(res.written.join('')).toBe('console.log(1)');
    expect(res.ended).toBe(true);
  });

  it('la raíz sin barra final llega como /', async () => {
    const previewRequest = vi.fn().mockResolvedValue(new Response('<html>'));
    await withPreview(previewRequest).preview(
      's1',
      '5173',
      fakeReq({ originalUrl: '/api/terminal/sessions/s1/preview/5173' }),
      fakeRes() as unknown as ExpressResponse,
    );
    expect((previewRequest.mock.calls[0] as unknown[])[2]).toMatchObject({
      pathAndQuery: '/',
    });
  });

  it('devuelve el estado del servidor y solo cabeceras seguras: sin set-cookie, sin cache; nunca cachea', async () => {
    const previewRequest = vi.fn().mockResolvedValue(
      new Response('no', {
        status: 404,
        headers: {
          'content-type': 'text/plain',
          'set-cookie': 'a=b',
          'cache-control': 'public, max-age=999',
          'x-powered-by': 'express',
        },
      }),
    );
    const res = fakeRes();
    await withPreview(previewRequest).preview(
      's1',
      '5173',
      fakeReq(),
      res as unknown as ExpressResponse,
    );

    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('un puerto que no es de usuario o no es un número se rechaza antes de tocar el Executor', async () => {
    const previewRequest = vi.fn();
    for (const port of ['80', '1023', '65536', '5173abc', '0x1400', '']) {
      await expect(
        withPreview(previewRequest).preview(
          's1',
          port,
          fakeReq(),
          fakeRes() as unknown as ExpressResponse,
        ),
      ).rejects.toThrow(/Puerto/);
    }
    expect(previewRequest).not.toHaveBeenCalled();
  });

  it('reenvía el cuerpo JSON de un POST y cuando el cliente se va corta la conexión', async () => {
    let signal: AbortSignal | undefined;
    const previewRequest = vi
      .fn()
      .mockImplementation(
        (_id: string, _port: number, request: { signal: AbortSignal }) => {
          signal = request.signal;
          return Promise.resolve(new Response('ok'));
        },
      );
    const res = fakeRes();
    const pending = withPreview(previewRequest).preview(
      's1',
      '3000',
      fakeReq({
        method: 'POST',
        body: { a: 1 },
        originalUrl: '/api/terminal/sessions/s1/preview/3000/api/items',
      }),
      res as unknown as ExpressResponse,
    );
    res.emit('close');
    await pending;

    const call = previewRequest.mock.calls[0] as [
      string,
      number,
      { body?: Buffer },
    ];
    expect(call[2].body?.toString()).toBe('{"a":1}');
    expect(signal?.aborted).toBe(true);
  });

  it('un fallo del Executor antes del primer byte sale como error HTTP normal', async () => {
    const previewRequest = vi
      .fn()
      .mockRejectedValue(new TerminalUpstreamError(404, 'No existe la sesión'));
    const res = fakeRes();
    await expect(
      withPreview(previewRequest).preview(
        's1',
        '5173',
        fakeReq(),
        res as unknown as ExpressResponse,
      ),
    ).rejects.toBeInstanceOf(TerminalUpstreamError);
    expect(res.statusCode).toBeUndefined();
  });
});
