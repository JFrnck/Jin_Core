import { describe, expect, it, vi } from 'vitest';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { ExecutorClientModule } from './executor-client.module';
import type {
  ExecutorClientService,
  PreviewServiceInfo,
  StartPreviewServiceInput,
} from './executor-client.service';

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

  it('startPreviewService: la aprobación que lo originó viene del contexto, y un requestId dentro del payload (que puede escribir el modelo) se ignora', async () => {
    const registry = new ToolExecutorRegistry();
    const startPreviewService = vi.fn().mockResolvedValue({ id: 'svc-1' });
    new ExecutorClientModule(registry, {
      startPreviewService,
    } as unknown as ExecutorClientService).onModuleInit();

    await registry.execute(
      'startPreviewService',
      {
        template: 'static',
        files: { 'index.html': 'x' },
        ttlSeconds: 3600,
        requestId: 'falsificado-por-el-modelo',
      },
      { requestId: '11111111-1111-4111-8111-111111111111' },
    );
    expect(startPreviewService).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: '11111111-1111-4111-8111-111111111111',
      }),
    );

    startPreviewService.mockClear();
    await registry.execute('startPreviewService', {
      template: 'static',
      files: { 'index.html': 'x' },
      ttlSeconds: 3600,
      requestId: 'falsificado-por-el-modelo',
    });
    expect(startPreviewService.mock.calls[0]?.[0]).not.toHaveProperty(
      'requestId',
    );
  });

  it('extendPreviewService: la tool llama al Executor con el id y los segundos y devuelve el nuevo vencimiento', async () => {
    const registry = new ToolExecutorRegistry();
    const info = { id: 'svc-1', expiresAt: '2026-10-05T00:00:00.000Z' };
    const extendPreviewService = vi.fn().mockResolvedValue(info);
    new ExecutorClientModule(registry, {
      extendPreviewService,
    } as unknown as ExecutorClientService).onModuleInit();

    const result = await registry.execute('extendPreviewService', {
      serviceId: 'svc-1',
      extraSeconds: 172_800,
    });

    expect(result).toEqual(info);
    expect(extendPreviewService).toHaveBeenCalledWith('svc-1', 172_800);
  });

  it('startPreviewService con mailEgress: la bandera llega al Executor; sin ella (o en false), no viaja', async () => {
    const registry = new ToolExecutorRegistry();
    const startPreviewService =
      vi.fn<(input: StartPreviewServiceInput) => Promise<PreviewServiceInfo>>();
    new ExecutorClientModule(registry, {
      startPreviewService,
    } as unknown as ExecutorClientService).onModuleInit();
    const base = {
      files: { 'index.js': 'x' },
      command: ['node', 'index.js'],
      port: 3000,
      ttlSeconds: 3600,
    };

    await registry.execute('startPreviewService', {
      ...base,
      mailEgress: true,
    });
    await registry.execute('startPreviewService', {
      ...base,
      mailEgress: false,
    });
    await registry.execute('startPreviewService', base);

    expect(startPreviewService.mock.calls[0]?.[0].mailEgress).toBe(true);
    expect(startPreviewService.mock.calls[1]?.[0]).not.toHaveProperty(
      'mailEgress',
    );
    expect(startPreviewService.mock.calls[2]?.[0]).not.toHaveProperty(
      'mailEgress',
    );
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

  it('startPreviewService con template "static": el Executor recibe el servidor fijo de Jin', async () => {
    const registry = new ToolExecutorRegistry();
    const startPreviewService =
      vi.fn<(input: StartPreviewServiceInput) => Promise<PreviewServiceInfo>>();
    new ExecutorClientModule(registry, {
      startPreviewService,
    } as unknown as ExecutorClientService).onModuleInit();

    await registry.execute('startPreviewService', {
      template: 'static',
      files: { 'index.html': '<h1>hola</h1>' },
      ttlSeconds: 3600,
    });

    expect(startPreviewService).toHaveBeenCalledTimes(1);
    const request = startPreviewService.mock.calls[0]![0];
    expect(request.command).toEqual(['node', '.jin/static-server.mjs']);
    expect(request.port).toBe(8080);
    expect(request.files['index.html']).toBe('<h1>hola</h1>');
    expect(request.files['.jin/static-server.mjs']).toContain('createServer');
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
