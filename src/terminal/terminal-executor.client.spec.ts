import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { TerminalExecutorClient } from './terminal-executor.client';
import {
  TerminalUnavailableError,
  TerminalUpstreamError,
} from './terminal.errors';

function client(): TerminalExecutorClient {
  const config = {
    get: () => 'http://jin-executor:3001/',
  } as unknown as ConfigService<Env, true>;
  return new TerminalExecutorClient(config);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TerminalExecutorClient', () => {
  let fetchMock: Mock<typeof fetch>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('arma las rutas del Executor con el id codificado y sin barras dobles', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json({ ok: true })));
    const c = client();
    await c.list();
    await c.stop('a/b');
    await c.exportFiles('s1', 'app/dist');
    await c.importFiles('s1', { 'a.js': '1' });

    const urls = fetchMock.mock.calls.map(
      (call) =>
        `${(call[1] as { method: string }).method} ${call[0] as string}`,
    );
    expect(urls).toEqual([
      'GET http://jin-executor:3001/terminal/sessions',
      'DELETE http://jin-executor:3001/terminal/sessions/a%2Fb',
      'GET http://jin-executor:3001/terminal/sessions/s1/files?dir=app%2Fdist',
      'PUT http://jin-executor:3001/terminal/sessions/s1/files',
    ]);
  });

  it('start manda archivos y TTL como JSON', async () => {
    fetchMock.mockResolvedValue(json({ id: 's1' }));
    await client().start({ files: { 'a.js': '1' }, ttlSeconds: 3600 });
    const init = fetchMock.mock.calls[0]?.[1] as {
      body: string;
      headers: Record<string, string>;
    };
    expect(JSON.parse(init.body)).toEqual({
      files: { 'a.js': '1' },
      ttlSeconds: 3600,
    });
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('los rechazos que el owner puede entender conservan estado y mensaje', async () => {
    fetchMock.mockResolvedValue(
      json(
        {
          statusCode: 429,
          code: 'TERMINAL_LIMIT_REACHED',
          message: 'Ya hay 1 sesión(es)',
        },
        429,
      ),
    );
    const error = await client()
      .list()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TerminalUpstreamError);
    expect((error as TerminalUpstreamError).httpStatus).toBe(429);
    expect((error as TerminalUpstreamError).message).toBe(
      'Ya hay 1 sesión(es)',
    );
  });

  it('un 500 del Executor sale como 502 y un cuerpo que no es JSON no rompe', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const error = await client()
      .list()
      .catch((e: unknown) => e);
    expect((error as TerminalUpstreamError).httpStatus).toBe(502);
    expect((error as TerminalUpstreamError).message).toBe('boom');
  });

  it('si no se puede contactar al Executor, error claro (502)', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const error = await client()
      .list()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TerminalUnavailableError);
    expect((error as TerminalUnavailableError).httpStatus).toBe(502);
  });

  it('openExec pasa la señal de corte y, si la conexión se aborta, propaga el aborto tal cual', async () => {
    fetchMock.mockResolvedValue(new Response('x'));
    const controller = new AbortController();
    await client().openExec('s1', { command: 'ls' }, controller.signal);
    expect(
      (fetchMock.mock.calls[0]?.[1] as { signal: AbortSignal }).signal,
    ).toBe(controller.signal);

    controller.abort();
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const error = await client()
      .openExec('s1', { command: 'ls' }, controller.signal)
      .catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(TerminalUnavailableError);
  });
});
