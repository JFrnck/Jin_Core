import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../config/env.schema';
import { ExecutorClientService } from './executor-client.service';
import { ExecutorApiError } from './errors';

describe('ExecutorClientService', () => {
  let service: ExecutorClientService;

  beforeEach(() => {
    const mockConfigService: Partial<ConfigService<Env, true>> = {
      get: (key: keyof Env) => {
        if (key === 'EXECUTOR_BASE_URL')
          return 'https://executor.test.internal';
        return undefined;
      },
    };

    service = new ExecutorClientService(
      mockConfigService as ConfigService<Env, true>,
    );
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('llama a POST /execute con el contrato exacto del Executor, env siempre {}', async () => {
    const mockResult = { runId: 'abc-123', succeeded: true, logs: 'hola\n' };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResult),
    } as Response);

    const result = await service.runCode({
      code: 'print("hola")',
      language: 'python',
    });

    expect(result).toEqual(mockResult);
    expect(fetch).toHaveBeenCalledWith(
      'https://executor.test.internal/execute',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'runCode',
          code: 'print("hola")',
          language: 'python',
          env: {},
          timeout: 1800,
        }),
      },
    );
  });

  it('normaliza una barra final en EXECUTOR_BASE_URL', async () => {
    const mockConfigService: Partial<ConfigService<Env, true>> = {
      get: (key: keyof Env) => {
        if (key === 'EXECUTOR_BASE_URL')
          return 'https://executor.test.internal/';
        return undefined;
      },
    };
    service = new ExecutorClientService(
      mockConfigService as ConfigService<Env, true>,
    );
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ runId: 'x', succeeded: true, logs: '' }),
    } as Response);

    await service.runCode({ code: 'console.log(1)', language: 'typescript' });

    expect(fetch).toHaveBeenCalledWith(
      'https://executor.test.internal/execute',
      expect.any(Object),
    );
  });

  it('lanza ExecutorApiError cuando el Executor responde con error HTTP', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: () => Promise.resolve('Error ejecutando en Modal: timeout'),
    } as Response);

    await expect(
      service.runCode({ code: 'import pandas', language: 'python' }),
    ).rejects.toThrow(ExecutorApiError);
  });

  it('startPreviewService: POST /services con tool="startPreviewService" + el input completo', async () => {
    const mockInfo = {
      id: 'svc-1',
      slug: 'demo-a1b2c3',
      url: 'https://demo-a1b2c3.jinserver.com',
      status: 'running',
      expiresAt: '2026-08-01T12:00:00.000Z',
    };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockInfo),
    } as Response);

    const result = await service.startPreviewService({
      files: { 'index.js': 'console.log(1)' },
      command: ['node', 'index.js'],
      port: 3000,
      ttlSeconds: 3600,
    });

    expect(result).toEqual(mockInfo);
    expect(fetch).toHaveBeenCalledWith(
      'https://executor.test.internal/services',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'startPreviewService',
          files: { 'index.js': 'console.log(1)' },
          command: ['node', 'index.js'],
          port: 3000,
          ttlSeconds: 3600,
        }),
      },
    );
  });

  it('startPreviewService: lanza ExecutorApiError si el Executor responde 429 (límite de concurrencia)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: () => Promise.resolve('límite alcanzado'),
    } as Response);

    await expect(
      service.startPreviewService({
        files: {},
        command: ['node'],
        port: 3000,
        ttlSeconds: 60,
      }),
    ).rejects.toThrow(ExecutorApiError);
  });

  it('stopPreviewService: DELETE /services/:id, sin body', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as Response);

    await service.stopPreviewService('svc-1');

    expect(fetch).toHaveBeenCalledWith(
      'https://executor.test.internal/services/svc-1',
      { method: 'DELETE' },
    );
  });

  it('extendPreviewService: POST /services/:id/extend con {extraSeconds}, devuelve el nuevo vencimiento', async () => {
    const info = {
      id: 'svc-1',
      slug: 'demo-a1b2c3',
      url: 'https://demo-a1b2c3.jinserver.com',
      status: 'running',
      expiresAt: '2026-10-05T09:18:47.332Z',
    };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(info),
    } as Response);

    const result = await service.extendPreviewService('svc-1', 86_400);

    expect(result).toEqual(info);
    expect(fetch).toHaveBeenCalledWith(
      'https://executor.test.internal/services/svc-1/extend',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extraSeconds: 86_400 }),
      },
    );
  });

  it('extendPreviewService: lanza ExecutorApiError si el Executor responde 409 (tope de vida)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 409,
      text: () => Promise.resolve('tope'),
    } as Response);

    await expect(service.extendPreviewService('svc-1', 60)).rejects.toThrow(
      ExecutorApiError,
    );
  });

  it('saveGithubDemo: POST /github/demos con {serviceId, slug}; devuelve el resultado', async () => {
    const result = {
      repo: 'owner/jin-demos',
      branch: 'demo/reservas',
      slug: 'reservas',
      commit: 'abc123',
      files: 3,
      unchanged: false,
      skipped: [],
      url: 'https://github.com/owner/jin-demos/tree/demo/reservas',
    };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(result),
    } as Response);

    const saved = await service.saveGithubDemo({
      serviceId: 'svc-1',
      slug: 'reservas',
    });

    expect(saved).toEqual(result);
    expect(fetch).toHaveBeenCalledWith(
      'https://executor.test.internal/github/demos',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceId: 'svc-1', slug: 'reservas' }),
      },
    );
  });

  it('saveGithubDemo: un error del Executor (GitHub apagado, repo no permitido) sale como ExecutorApiError', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: () => Promise.resolve('GitHub no está configurado'),
    } as Response);

    await expect(
      service.saveGithubDemo({ serviceId: 'svc-1', slug: 'x' }),
    ).rejects.toThrow(ExecutorApiError);
  });

  it('listGithubDemos: GET /github/demos, devuelve las ramas', async () => {
    const branches = [{ slug: 'a', branch: 'demo/a', commit: 'c1' }];
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(branches),
    } as Response);

    expect(await service.listGithubDemos()).toEqual(branches);
    expect(fetch).toHaveBeenCalledWith(
      'https://executor.test.internal/github/demos',
    );
  });

  it('listPreviewServices: GET /services, devuelve el array tal cual', async () => {
    const mockList = [
      {
        id: 'svc-1',
        slug: 'demo-a1b2c3',
        url: 'https://demo-a1b2c3.jinserver.com',
        status: 'running',
        expiresAt: '2026-08-01T12:00:00.000Z',
      },
    ];
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockList),
    } as Response);

    const result = await service.listPreviewServices();

    expect(result).toEqual(mockList);
    expect(fetch).toHaveBeenCalledWith(
      'https://executor.test.internal/services',
    );
  });
});
