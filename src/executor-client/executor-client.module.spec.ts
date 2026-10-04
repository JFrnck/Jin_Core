import { describe, expect, it, vi } from 'vitest';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { EnvVaultService } from './env-vault.service';
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

  it('saveDemoToGithub y listGithubDemos: las tools llaman al Executor con lo que el modelo pidió (y solo eso)', async () => {
    const registry = new ToolExecutorRegistry();
    const saveGithubDemo = vi.fn().mockResolvedValue({ branch: 'demo/x' });
    const listGithubDemos = vi.fn().mockResolvedValue([]);
    new ExecutorClientModule(registry, {
      saveGithubDemo,
      listGithubDemos,
    } as unknown as ExecutorClientService).onModuleInit();

    // Un `repo` o `force` que el modelo meta en el payload NO viaja: el repo lo fija el Executor.
    await registry.execute('saveDemoToGithub', {
      serviceId: 'svc-1',
      slug: 'x',
      repo: 'otro/repo',
      force: true,
    });
    await registry.execute('listGithubDemos', {});

    expect(saveGithubDemo).toHaveBeenCalledWith({
      serviceId: 'svc-1',
      slug: 'x',
    });
    expect(listGithubDemos).toHaveBeenCalledTimes(1);
  });

  it('startPreviewService con secrets: solo los NOMBRES llegan al Executor', async () => {
    const registry = new ToolExecutorRegistry();
    const startPreviewService =
      vi.fn<(input: StartPreviewServiceInput) => Promise<PreviewServiceInfo>>();
    new ExecutorClientModule(registry, {
      startPreviewService,
    } as unknown as ExecutorClientService).onModuleInit();

    await registry.execute('startPreviewService', {
      files: {
        'package.json': JSON.stringify({ scripts: { start: 'node s.js' } }),
      },
      template: 'node',
      ttlSeconds: 3600,
      mailEgress: true,
      secrets: ['brevo'],
    });

    expect(startPreviewService.mock.calls[0]?.[0].secrets).toEqual(['brevo']);
    expect(startPreviewService.mock.calls[0]?.[0].mailEgress).toBe(true);
  });

  describe('variables de entorno (ADR 0020)', () => {
    // Valores de ejemplo construidos en ejecución (nada con forma de credencial en el repo).
    const VALUE = `m${'7788990011'.repeat(3)}`;
    const files = {
      'package.json': JSON.stringify({ scripts: { start: 'node s.js' } }),
    };

    function setup() {
      const registry = new ToolExecutorRegistry();
      const vault = new EnvVaultService();
      const startPreviewService =
        vi.fn<
          (input: StartPreviewServiceInput) => Promise<PreviewServiceInfo>
        >();
      new ExecutorClientModule(
        registry,
        { startPreviewService } as unknown as ExecutorClientService,
        vault,
      ).onModuleInit();
      return { registry, vault, startPreviewService };
    }

    it('los valores salen de la bóveda por la aprobación y llegan al Executor; la bóveda queda vacía', async () => {
      const { registry, vault, startPreviewService } = setup();
      vault.put('req-1', { MI_CLAVE: VALUE });

      await registry.execute(
        'startPreviewService',
        { files, template: 'node', ttlSeconds: 60, envNames: ['MI_CLAVE'] },
        { requestId: 'req-1' },
      );

      expect(startPreviewService.mock.calls[0]?.[0].env).toEqual({
        MI_CLAVE: VALUE,
      });
      expect(startPreviewService.mock.calls[0]?.[0].requestId).toBe('req-1');
      expect(vault.has('req-1')).toBe(false);
    });

    it('un `env` con valores dentro del payload (lo puede escribir el modelo) se IGNORA siempre', async () => {
      const { registry, startPreviewService } = setup();

      await registry.execute('startPreviewService', {
        files,
        template: 'node',
        ttlSeconds: 60,
        env: { ROBADA: VALUE },
      });

      expect(startPreviewService.mock.calls[0]?.[0]).not.toHaveProperty('env');
    });

    it('nombres sin valores en la bóveda (reinicio de Core, vencida, o el modelo inventó envNames): error claro y NO se crea la demo', async () => {
      const { registry, startPreviewService } = setup();

      await expect(
        registry.execute(
          'startPreviewService',
          { files, template: 'node', ttlSeconds: 60, envNames: ['MI_CLAVE'] },
          { requestId: 'req-sin-valores' },
        ),
      ).rejects.toThrow(/no están disponibles/);
      expect(startPreviewService).not.toHaveBeenCalled();
    });

    it('si los valores de la bóveda no coinciden con los nombres aprobados, se rechaza', async () => {
      const { registry, vault, startPreviewService } = setup();
      vault.put('req-1', { OTRA: VALUE });

      await expect(
        registry.execute(
          'startPreviewService',
          { files, template: 'node', ttlSeconds: 60, envNames: ['MI_CLAVE'] },
          { requestId: 'req-1' },
        ),
      ).rejects.toThrow(/no coinciden/);
      expect(startPreviewService).not.toHaveBeenCalled();
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
