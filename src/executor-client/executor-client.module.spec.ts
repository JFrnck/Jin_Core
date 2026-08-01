import { describe, expect, it, vi } from 'vitest';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { ExecutorClientModule } from './executor-client.module';
import type { ExecutorClientService } from './executor-client.service';

describe('ExecutorClientModule', () => {
  it('registra el executor de runCode en ToolExecutorRegistry al iniciar', async () => {
    const registry = new ToolExecutorRegistry();
    const executorClientService: Partial<ExecutorClientService> = {
      runCode: vi.fn().mockResolvedValue({
        runId: 'run-1',
        succeeded: true,
        logs: 'ok',
      }),
    };

    const module = new ExecutorClientModule(
      registry,
      executorClientService as ExecutorClientService,
    );
    module.onModuleInit();

    const result = await registry.execute('runCode', {
      code: 'console.log(1)',
      language: 'typescript',
    });

    expect(result).toEqual({ runId: 'run-1', succeeded: true, logs: 'ok' });
    expect(executorClientService.runCode).toHaveBeenCalledWith({
      code: 'console.log(1)',
      language: 'typescript',
    });
  });

  it('registra startPreviewService (Fase 5.5, ADR 0006) — pasa el payload completo tal cual', async () => {
    const registry = new ToolExecutorRegistry();
    const mockInfo = {
      id: 'svc-1',
      slug: 'demo-a1b2c3',
      url: 'https://demo-a1b2c3.jinserver.com',
      status: 'running',
      expiresAt: '2026-08-01T12:00:00.000Z',
    };
    const executorClientService: Partial<ExecutorClientService> = {
      startPreviewService: vi.fn().mockResolvedValue(mockInfo),
    };
    const module = new ExecutorClientModule(
      registry,
      executorClientService as ExecutorClientService,
    );
    module.onModuleInit();

    const payload = {
      files: { 'index.js': 'x' },
      command: ['node', 'index.js'],
      port: 3000,
      ttlSeconds: 3600,
    };
    const result = await registry.execute('startPreviewService', payload);

    expect(result).toEqual(mockInfo);
    expect(executorClientService.startPreviewService).toHaveBeenCalledWith(
      payload,
    );
  });

  it('registra stopPreviewService (notify) — ejecuta ya, sin esperar aprobación', async () => {
    const registry = new ToolExecutorRegistry();
    const executorClientService: Partial<ExecutorClientService> = {
      stopPreviewService: vi.fn().mockResolvedValue(undefined),
    };
    const module = new ExecutorClientModule(
      registry,
      executorClientService as ExecutorClientService,
    );
    module.onModuleInit();

    const result = await registry.execute('stopPreviewService', {
      serviceId: 'svc-1',
    });

    expect(result).toEqual({ serviceId: 'svc-1', stopped: true });
    expect(executorClientService.stopPreviewService).toHaveBeenCalledWith(
      'svc-1',
    );
  });

  it('registra listPreviewServices (auto) — sin input, devuelve la lista tal cual', async () => {
    const registry = new ToolExecutorRegistry();
    const mockList = [
      {
        id: 'svc-1',
        slug: 'demo-a1b2c3',
        url: 'https://demo-a1b2c3.jinserver.com',
        status: 'running',
        expiresAt: '2026-08-01T12:00:00.000Z',
      },
    ];
    const executorClientService: Partial<ExecutorClientService> = {
      listPreviewServices: vi.fn().mockResolvedValue(mockList),
    };
    const module = new ExecutorClientModule(
      registry,
      executorClientService as ExecutorClientService,
    );
    module.onModuleInit();

    const result = await registry.execute('listPreviewServices', {});

    expect(result).toEqual(mockList);
  });
});
