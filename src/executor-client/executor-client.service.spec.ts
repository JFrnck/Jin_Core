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
});
