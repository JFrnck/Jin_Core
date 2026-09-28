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
    await c.stopPod('a/b');
    await c.deleteWorkspace('a/b');
    await c.exportFiles('s1', 'app/dist');
    await c.importFiles('s1', { 'a.js': '1' });

    const urls = fetchMock.mock.calls.map(
      (call) =>
        `${(call[1] as { method: string }).method} ${call[0] as string}`,
    );
    expect(urls).toEqual([
      'GET http://jin-executor:3001/terminal/workspaces',
      'DELETE http://jin-executor:3001/terminal/workspaces/a%2Fb/pod',
      'DELETE http://jin-executor:3001/terminal/workspaces/a%2Fb',
      'GET http://jin-executor:3001/terminal/workspaces/s1/files?dir=app%2Fdist',
      'PUT http://jin-executor:3001/terminal/workspaces/s1/files',
    ]);
  });

  it('start manda al workspace correcto, con archivos y TTL como JSON', async () => {
    fetchMock.mockResolvedValue(json({ id: 's1' }));
    await client().start('s1', { files: { 'a.js': '1' }, ttlSeconds: 3600 });
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(url).toBe('http://jin-executor:3001/terminal/workspaces/s1/start');
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
          code: 'TERMINAL_WORKSPACE_LIMIT_REACHED',
          message: 'Ya hay 10 proyecto(s)',
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
      'Ya hay 10 proyecto(s)',
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

  it('servidores: rutas y puerto', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(json({ log: 'ok', services: [] })),
    );
    const c = client();
    await c.startService('s1', { command: 'npm run dev', port: 5173 });
    await c.listServices('s1');
    await c.stopService('s1', 5173);
    await c.serviceLogs('s1', 5173);
    const calls = fetchMock.mock.calls.map(
      (call) =>
        `${(call[1] as { method: string }).method} ${call[0] as string}`,
    );
    expect(calls).toEqual([
      'POST http://jin-executor:3001/terminal/workspaces/s1/services',
      'GET http://jin-executor:3001/terminal/workspaces/s1/services',
      'DELETE http://jin-executor:3001/terminal/workspaces/s1/services/5173',
      'GET http://jin-executor:3001/terminal/workspaces/s1/services/5173/logs',
    ]);
  });

  describe('proxy de la vista previa', () => {
    const request = (signal: AbortSignal) => ({
      method: 'GET',
      pathAndQuery: '/src/main.js?t=1',
      headers: { accept: '*/*' },
      signal,
    });

    it('un 404 o 500 del servidor del owner (con la marca) se devuelve tal cual: es lo que quiere ver', async () => {
      for (const status of [404, 500]) {
        fetchMock.mockResolvedValueOnce(
          new Response('Cannot GET /x', {
            status,
            headers: { 'x-jin-proxied': '1' },
          }),
        );
        const response = await client().proxy(
          's1',
          5173,
          request(new AbortController().signal),
        );
        expect(response.status).toBe(status);
      }
    });

    it('un fallo del propio Executor (sin la marca: workspace inexistente, puerto inválido) sale como error con su mensaje', async () => {
      fetchMock.mockResolvedValueOnce(
        json({ statusCode: 404, message: 'No existe el workspace s1' }, 404),
      );
      const error = await client()
        .proxy('s1', 5173, request(new AbortController().signal))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TerminalUpstreamError);
      expect((error as TerminalUpstreamError).httpStatus).toBe(404);
    });

    it('arma la URL con la ruta y la query tal cual, no sigue redirecciones y pasa la señal', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('x', { headers: { 'x-jin-proxied': '1' } }),
      );
      const controller = new AbortController();
      await client().proxy('s1', 5173, request(controller.signal));
      const [url, init] = fetchMock.mock.calls[0] as [
        string,
        { redirect: string; signal: AbortSignal },
      ];
      expect(url).toBe(
        'http://jin-executor:3001/terminal/workspaces/s1/proxy/5173/src/main.js?t=1',
      );
      expect(init.redirect).toBe('manual');
      expect(init.signal).toBe(controller.signal);
    });
  });
});
