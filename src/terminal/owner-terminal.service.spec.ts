import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { DualConfirmService } from '../hitl/dual-confirm.service';
import { UnknownToolError } from '../hitl/errors';
import { classifyToolCall } from '../hitl/classifier';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { STATIC_SERVER_SOURCE } from '../executor-client/preview-template.logic';
import { getToolDefinition, listRegisteredTools } from '../tools/registry';
import { OwnerTerminalService } from './owner-terminal.service';
import type {
  TerminalExecutorClient,
  TerminalWorkspaceInfo,
} from './terminal-executor.client';
import { TerminalUpstreamError } from './terminal.errors';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

function workspace(
  over: Partial<TerminalWorkspaceInfo> = {},
): TerminalWorkspaceInfo {
  return {
    id: WORKSPACE_ID,
    status: 'running',
    createdAt: '2026-09-28T18:00:00.000Z',
    expiresAt: '2026-09-28T20:00:00.000Z',
    requestId: null,
    exposure: null,
    lastActivityAt: '2026-09-28T19:00:00.000Z',
    ...over,
  };
}

describe('OwnerTerminalService', () => {
  const order: string[] = [];
  let list: ReturnType<typeof vi.fn>;
  let start: ReturnType<typeof vi.fn>;
  let stopPod: ReturnType<typeof vi.fn>;
  let deleteWorkspace: ReturnType<typeof vi.fn>;
  let expose: ReturnType<typeof vi.fn>;
  let openExec: ReturnType<typeof vi.fn>;
  let importFiles: ReturnType<typeof vi.fn>;
  let startService: ReturnType<typeof vi.fn>;
  let stopService: ReturnType<typeof vi.fn>;
  let proxy: ReturnType<typeof vi.fn>;
  let createPendingApproval: ReturnType<typeof vi.fn>;
  let recordToolCall: ReturnType<typeof vi.fn>;
  let registry: ToolExecutorRegistry;
  let service: OwnerTerminalService;

  beforeEach(() => {
    order.length = 0;
    list = vi.fn().mockResolvedValue([]);
    start = vi.fn().mockResolvedValue(workspace());
    stopPod = vi.fn().mockResolvedValue(undefined);
    deleteWorkspace = vi.fn().mockResolvedValue(undefined);
    expose = vi.fn().mockResolvedValue({
      slug: 'app-abc123',
      url: 'https://app-abc123.jinserver.com',
    });
    openExec = vi.fn().mockImplementation(() => {
      order.push('openExec');
      return Promise.resolve(new Response('ok'));
    });
    importFiles = vi.fn().mockResolvedValue({ written: 2 });
    startService = vi.fn().mockImplementation(() => {
      order.push('startService');
      return Promise.resolve({ status: 'listening', port: 5173, log: '' });
    });
    stopService = vi.fn().mockResolvedValue(undefined);
    proxy = vi.fn().mockResolvedValue(new Response('ok'));
    createPendingApproval = vi.fn().mockResolvedValue(undefined);
    recordToolCall = vi.fn().mockImplementation(() => {
      order.push('audit');
      return Promise.resolve({});
    });
    registry = new ToolExecutorRegistry();
    service = new OwnerTerminalService(
      { createPendingApproval } as unknown as DualConfirmService,
      registry,
      {
        list,
        start,
        stopPod,
        deleteWorkspace,
        expose,
        openExec,
        importFiles,
        startService,
        stopService,
        proxy,
      } as unknown as TerminalExecutorClient,
      { recordToolCall } as unknown as AuditService,
    );
    service.onModuleInit();
  });

  describe('no son tools del modelo', () => {
    it('las 5 tools de terminal no están en el registry: el LLM no las ve ni puede invocarlas', () => {
      for (const name of [
        'startTerminalSession',
        'exposeTerminalSession',
        'runTerminalCommand',
        'stopTerminalSession',
        'deleteTerminalWorkspace',
      ]) {
        expect(getToolDefinition(name)).toBeUndefined();
        expect(listRegisteredTools().map((tool) => tool.name)).not.toContain(
          name,
        );
        expect(() => classifyToolCall(name, {})).toThrow(UnknownToolError);
      }
    });
  });

  describe('abrir o reanudar un workspace', () => {
    const input = { files: { 'index.html': '<h1>x</h1>' }, ttlSeconds: 3600 };

    it('deja una aprobación confirm del owner y NO abre nada hasta que la apruebe', async () => {
      const result = await service.requestStart(WORKSPACE_ID, input);

      expect(result.status).toBe('pending-approval');
      expect(createPendingApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: result.requestId,
          toolName: 'startTerminalSession',
          level: 'confirm',
          actor: 'owner:terminal',
          payload: { workspaceId: WORKSPACE_ID, ...input },
        }),
      );
      expect(start).not.toHaveBeenCalled();
    });

    it('el nivel es fijo: no consulta política ni modos de autonomía (nada la relaja)', async () => {
      // Sin HitlPolicyService en el constructor: no hay forma de relajarlo.
      expect(OwnerTerminalService.length).toBe(4);
      await service.requestStart(WORKSPACE_ID, input);
      expect(createPendingApproval.mock.calls[0]?.[0]).toMatchObject({
        level: 'confirm',
      });
    });

    it('el resumen dice "abrir" para un proyecto nuevo y "reanudar" para uno que ya existe', async () => {
      await service.requestStart(WORKSPACE_ID, {
        files: {},
        ttlSeconds: 7200,
      });
      const firstSummary = (
        createPendingApproval.mock.calls[0]?.[0] as { planSummary: string }
      ).planSummary;
      expect(firstSummary).toContain('Abrir');
      expect(firstSummary).toContain('2 h');
      expect(firstSummary).toContain('0 archivos');
      expect(firstSummary).toContain('proxy de npm');

      list.mockResolvedValue([workspace({ status: 'stopped' })]);
      await service.requestStart(WORKSPACE_ID, {
        files: {},
        ttlSeconds: 3600,
      });
      const secondSummary = (
        createPendingApproval.mock.calls[1]?.[0] as { planSummary: string }
      ).planSummary;
      expect(secondSummary).toContain('Reanudar');
      expect(secondSummary).toContain('mismo disco');
    });

    it('si ese workspace ya tiene un pod vivo, responde 409 sin crear una aprobación inútil', async () => {
      list.mockResolvedValue([workspace()]);
      const error = await service
        .requestStart(WORKSPACE_ID, input)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TerminalUpstreamError);
      expect((error as TerminalUpstreamError).httpStatus).toBe(409);
      expect(createPendingApproval).not.toHaveBeenCalled();
    });

    it('otro workspace corriendo no bloquea abrir este (varios proyectos, no una sola sesión global)', async () => {
      list.mockResolvedValue([workspace({ id: 'otro-proyecto' })]);
      await expect(
        service.requestStart(WORKSPACE_ID, input),
      ).resolves.toMatchObject({ status: 'pending-approval' });
    });

    it('un workspace parado, vencido o fallido no bloquea abrirlo de nuevo', async () => {
      for (const status of ['stopped', 'expired', 'failed'] as const) {
        createPendingApproval.mockClear();
        list.mockResolvedValue([workspace({ status })]);
        await expect(
          service.requestStart(WORKSPACE_ID, input),
        ).resolves.toMatchObject({ status: 'pending-approval' });
      }
    });

    it('al aprobarla, el ejecutor registrado inicia el workspace correcto con lo aprobado', async () => {
      await registry.execute('startTerminalSession', {
        workspaceId: WORKSPACE_ID,
        ...input,
      });
      expect(start).toHaveBeenCalledWith(WORKSPACE_ID, {
        files: input.files,
        ttlSeconds: 3600,
      });
    });

    it('el id de la aprobación viene del contexto de ejecución; un requestId dentro del payload guardado se rechaza (no se puede falsificar)', async () => {
      await registry.execute(
        'startTerminalSession',
        { workspaceId: WORKSPACE_ID, ...input },
        { requestId: '22222222-2222-4222-8222-222222222222' },
      );
      expect(start).toHaveBeenCalledWith(WORKSPACE_ID, {
        files: input.files,
        ttlSeconds: 3600,
        requestId: '22222222-2222-4222-8222-222222222222',
      });

      start.mockClear();
      await expect(
        registry.execute(
          'startTerminalSession',
          {
            workspaceId: WORKSPACE_ID,
            ...input,
            requestId: '99999999-9999-4999-8999-999999999999',
          },
          { requestId: '22222222-2222-4222-8222-222222222222' },
        ),
      ).rejects.toThrow();
      expect(start).not.toHaveBeenCalled();
    });

    it('al aprobarla, un payload alterado se rechaza (defensa en profundidad)', async () => {
      await expect(
        registry.execute('startTerminalSession', {
          workspaceId: WORKSPACE_ID,
          files: { '../x': 'x' },
          ttlSeconds: 3600,
        }),
      ).rejects.toThrow();
      await expect(
        registry.execute('startTerminalSession', {
          workspaceId: 'no-es-un-uuid',
          files: {},
          ttlSeconds: 3600,
        }),
      ).rejects.toThrow();
      expect(start).not.toHaveBeenCalled();
    });
  });

  describe('publicar un build', () => {
    it('sin pod corriendo: 404; ya publicado: 409; en ambos casos no hay aprobación', async () => {
      const missing = await service
        .requestExpose(WORKSPACE_ID, { dir: 'dist' })
        .catch((e: unknown) => e);
      expect((missing as TerminalUpstreamError).httpStatus).toBe(404);

      list.mockResolvedValue([
        workspace({ exposure: { slug: 'a', url: 'u' } }),
      ]);
      const twice = await service
        .requestExpose(WORKSPACE_ID, { dir: 'dist' })
        .catch((e: unknown) => e);
      expect((twice as TerminalUpstreamError).httpStatus).toBe(409);
      expect(createPendingApproval).not.toHaveBeenCalled();
    });

    it('deja una aprobación confirm con el workspace y el directorio, sin publicar todavía', async () => {
      list.mockResolvedValue([workspace()]);
      const result = await service.requestExpose(WORKSPACE_ID, {
        dir: 'dist',
        slugHint: 'mi-app',
      });

      expect(result.status).toBe('pending-approval');
      expect(createPendingApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'exposeTerminalSession',
          level: 'confirm',
          actor: 'owner:terminal',
          payload: {
            workspaceId: WORKSPACE_ID,
            dir: 'dist',
            slugHint: 'mi-app',
          },
        }),
      );
      expect(expose).not.toHaveBeenCalled();
    });

    it('al aprobarla publica con el servidor estático fijo de Jin y el puerto 8080', async () => {
      await registry.execute('exposeTerminalSession', {
        workspaceId: WORKSPACE_ID,
        dir: 'dist',
      });
      expect(expose).toHaveBeenCalledWith(WORKSPACE_ID, {
        dir: 'dist',
        slugHint: undefined,
        port: 8080,
        serverSource: STATIC_SERVER_SOURCE,
      });
    });

    it('un payload sin id de workspace o con un directorio que escapa se rechaza', async () => {
      await expect(
        registry.execute('exposeTerminalSession', { dir: 'dist' }),
      ).rejects.toThrow();
      await expect(
        registry.execute('exposeTerminalSession', {
          workspaceId: WORKSPACE_ID,
          dir: '../etc',
        }),
      ).rejects.toThrow();
      expect(expose).not.toHaveBeenCalled();
    });
  });

  describe('comandos', () => {
    it('audita ANTES de abrir el stream, con el actor y el comando', async () => {
      await service.exec(
        WORKSPACE_ID,
        { command: 'npm run build' },
        new AbortController().signal,
      );

      expect(order).toEqual(['audit', 'openExec']);
      expect(recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'owner:terminal',
          toolName: 'runTerminalCommand',
          approvalStatus: 'auto',
          planSummary: 'terminal: npm run build',
        }),
      );
    });

    it('fail-closed: si el audit falla, el comando NO corre', async () => {
      recordToolCall.mockRejectedValueOnce(new Error('audit caído'));
      await expect(
        service.exec(
          WORKSPACE_ID,
          { command: 'rm -rf node_modules' },
          new AbortController().signal,
        ),
      ).rejects.toThrow('audit caído');
      expect(openExec).not.toHaveBeenCalled();
    });

    it('en el audit queda una vista corta y una sola línea; el hash cubre el comando entero', async () => {
      const long = `echo ${'a'.repeat(300)}\n\n  && ls`;
      await service.exec(
        WORKSPACE_ID,
        { command: long },
        new AbortController().signal,
      );
      const call = recordToolCall.mock.calls[0]?.[0] as {
        planSummary: string;
        inputsHash: string;
      };
      expect(call.planSummary.startsWith('terminal: echo aaa')).toBe(true);
      expect(call.planSummary.length).toBeLessThanOrEqual(
        'terminal: '.length + 120,
      );
      expect(call.planSummary).not.toContain('\n');

      recordToolCall.mockClear();
      await service.exec(
        WORKSPACE_ID,
        { command: `${long} ` },
        new AbortController().signal,
      );
      expect(
        (recordToolCall.mock.calls[0]?.[0] as { inputsHash: string })
          .inputsHash,
      ).not.toBe(call.inputsHash);
    });

    it('le pasa al Executor el comando y el timeout tal cual, y su señal de corte', async () => {
      const controller = new AbortController();
      await service.exec(
        WORKSPACE_ID,
        { command: 'ls', timeoutSeconds: 30 },
        controller.signal,
      );
      expect(openExec).toHaveBeenCalledWith(
        WORKSPACE_ID,
        { command: 'ls', timeoutSeconds: 30 },
        controller.signal,
      );
    });
  });

  describe('servidores y vista previa en vivo', () => {
    it('lanzar un servidor se audita ANTES, como un comando, con el puerto en el resumen', async () => {
      await service.startService(WORKSPACE_ID, {
        command: 'npm run dev -- --host 0.0.0.0',
        port: 5173,
      });

      expect(order).toEqual(['audit', 'startService']);
      expect(recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          actor: 'owner:terminal',
          toolName: 'runTerminalCommand',
          approvalStatus: 'auto',
          planSummary:
            'terminal: [servidor :5173] npm run dev -- --host 0.0.0.0',
        }),
      );
    });

    it('fail-closed: si el audit falla, el servidor NO se lanza', async () => {
      recordToolCall.mockRejectedValueOnce(new Error('audit caído'));
      await expect(
        service.startService(WORKSPACE_ID, {
          command: 'node server.js',
          port: 3000,
        }),
      ).rejects.toThrow('audit caído');
      expect(startService).not.toHaveBeenCalled();
    });

    it('detener también queda en el audit', async () => {
      await service.stopService(WORKSPACE_ID, 5173);
      expect(recordToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          planSummary: 'terminal: detener el servidor :5173',
        }),
      );
      expect(stopService).toHaveBeenCalledWith(WORKSPACE_ID, 5173);
    });

    it('las peticiones de la vista previa NO se auditan una por una (una página son decenas)', async () => {
      await service.previewRequest(WORKSPACE_ID, 5173, {
        method: 'GET',
        pathAndQuery: '/',
        headers: {},
        signal: new AbortController().signal,
      });
      expect(recordToolCall).not.toHaveBeenCalled();
      expect(proxy).toHaveBeenCalledTimes(1);
    });
  });

  describe('detener el pod, borrar el workspace y copiar archivos: solo audit, sin aprobación', () => {
    it('detener el pod deja el disco intacto y queda en el audit', async () => {
      await service.stopPod(WORKSPACE_ID);
      expect(order).toEqual(['audit']);
      expect(recordToolCall).toHaveBeenLastCalledWith(
        expect.objectContaining({
          toolName: 'stopTerminalSession',
          actor: 'owner:terminal',
        }),
      );
      expect(stopPod).toHaveBeenCalledWith(WORKSPACE_ID);
      expect(deleteWorkspace).not.toHaveBeenCalled();
    });

    it('borrar el workspace (pod + disco) también es solo audit, sin aprobación', async () => {
      await service.deleteWorkspace(WORKSPACE_ID);
      expect(createPendingApproval).not.toHaveBeenCalled();
      expect(recordToolCall).toHaveBeenLastCalledWith(
        expect.objectContaining({
          toolName: 'deleteTerminalWorkspace',
          actor: 'owner:terminal',
          approvalStatus: 'auto',
        }),
      );
      expect(deleteWorkspace).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it('copiar archivos queda en el audit antes de actuar', async () => {
      await service.importFiles(WORKSPACE_ID, { 'a.js': '1', 'b.js': '2' });
      expect(recordToolCall).toHaveBeenLastCalledWith(
        expect.objectContaining({
          toolName: 'runTerminalCommand',
          planSummary: 'terminal: copiar 2 archivos del editor al proyecto',
        }),
      );
      expect(importFiles).toHaveBeenCalledWith(WORKSPACE_ID, {
        'a.js': '1',
        'b.js': '2',
      });
    });
  });
});
