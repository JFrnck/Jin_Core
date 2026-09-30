import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { DualConfirmService } from '../hitl/dual-confirm.service';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { OwnerTerminalService } from './owner-terminal.service';
import type { TerminalExecutorClient } from './terminal-executor.client';
import { StartTerminalSchema } from './terminal.schemas';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'sk-ant-oat01-TokenDePruebaQueNoDebeVerseEnElAudit0123456789';

function setup() {
  const registry = new ToolExecutorRegistry();
  const list = vi.fn().mockResolvedValue([]);
  const start = vi.fn().mockResolvedValue({});
  const openExec = vi.fn().mockResolvedValue(new Response('ok'));
  const startService = vi.fn().mockResolvedValue({ status: 'listening' });
  const createPendingApproval = vi.fn().mockResolvedValue(undefined);
  const recordToolCall = vi.fn().mockResolvedValue({});
  const service = new OwnerTerminalService(
    { createPendingApproval } as unknown as DualConfirmService,
    registry,
    {
      list,
      start,
      openExec,
      startService,
    } as unknown as TerminalExecutorClient,
    { recordToolCall } as unknown as AuditService,
  );
  service.onModuleInit();
  return {
    service,
    registry,
    list,
    start,
    openExec,
    startService,
    createPendingApproval,
    recordToolCall,
  };
}

describe('Claude Code en la terminal (ADR 0017)', () => {
  describe('esquema de abrir/reanudar', () => {
    const base = { files: {}, ttlSeconds: 3600 };

    it('claudeCode es opcional: ausente = no, y un valor que no es booleano se rechaza', () => {
      expect(StartTerminalSchema.parse(base)).not.toHaveProperty(
        'claudeCode',
        true,
      );
      expect(
        StartTerminalSchema.parse({ ...base, claudeCode: true }).claudeCode,
      ).toBe(true);
      expect(
        StartTerminalSchema.safeParse({ ...base, claudeCode: 'si' }).success,
      ).toBe(false);
      expect(
        StartTerminalSchema.safeParse({ ...base, claudeCode: 1 }).success,
      ).toBe(false);
    });

    it('sigue siendo estricto: no acepta campos de más (ni una clave de API "de contrabando")', () => {
      expect(
        StartTerminalSchema.safeParse({ ...base, anthropicApiKey: TOKEN })
          .success,
      ).toBe(false);
    });
  });

  describe('la aprobación', () => {
    it('con Claude Code, el resumen que lee el owner lo dice SIN ambigüedad y menciona el riesgo', async () => {
      const { service, createPendingApproval } = setup();
      await service.requestStart(WORKSPACE, {
        files: {},
        ttlSeconds: 3600,
        claudeCode: true,
      });

      const call = createPendingApproval.mock.calls[0]?.[0] as {
        planSummary: string;
        level: string;
        payload: { claudeCode?: boolean };
      };
      expect(call.planSummary).toContain('CON ACCESO A CLAUDE CODE');
      expect(call.planSummary).toContain('servidores de Anthropic');
      expect(call.planSummary).toContain('token de suscripción');
      expect(call.planSummary).toContain('malicioso');
      expect(call.payload.claudeCode).toBe(true);
    });

    it('sin Claude Code, el resumen sigue diciendo que no hay más red que el proxy de npm', async () => {
      const { service, createPendingApproval } = setup();
      await service.requestStart(WORKSPACE, { files: {}, ttlSeconds: 3600 });
      const call = createPendingApproval.mock.calls[0]?.[0] as {
        planSummary: string;
      };
      expect(call.planSummary).toContain('sin más red que el proxy de npm');
      expect(call.planSummary).not.toContain('CLAUDE CODE');
    });

    it('reanudar con Claude Code también lo dice', async () => {
      const { service, list, createPendingApproval } = setup();
      list.mockResolvedValue([{ id: WORKSPACE, status: 'stopped' }]);
      await service.requestStart(WORKSPACE, {
        files: {},
        ttlSeconds: 3600,
        claudeCode: true,
      });
      const call = createPendingApproval.mock.calls[0]?.[0] as {
        planSummary: string;
      };
      expect(call.planSummary).toMatch(/^Reanudar/);
      expect(call.planSummary).toContain('CON ACCESO A CLAUDE CODE');
    });

    it('el nivel sigue siendo confirm fijo (ningún modo de autonomía lo relaja)', async () => {
      const { service, createPendingApproval } = setup();
      await service.requestStart(WORKSPACE, {
        files: {},
        ttlSeconds: 3600,
        claudeCode: true,
      });
      expect(createPendingApproval.mock.calls[0]?.[0]).toMatchObject({
        level: 'confirm',
        toolName: 'startTerminalSession',
      });
      expect(OwnerTerminalService.length).toBe(4);
    });

    it('al aprobarla, el Executor recibe claudeCode: true; una aprobación vieja (sin el campo) abre sin Claude Code', async () => {
      const { registry, start } = setup();
      await registry.execute('startTerminalSession', {
        workspaceId: WORKSPACE,
        files: {},
        ttlSeconds: 3600,
        claudeCode: true,
      });
      expect(start).toHaveBeenLastCalledWith(
        WORKSPACE,
        expect.objectContaining({ claudeCode: true }),
      );

      await registry.execute('startTerminalSession', {
        workspaceId: WORKSPACE,
        files: {},
        ttlSeconds: 3600,
      });
      expect(start.mock.lastCall?.[1]).not.toHaveProperty('claudeCode', true);
    });
  });

  describe('el token nunca queda en el audit', () => {
    const summaries = (recordToolCall: ReturnType<typeof vi.fn>): string =>
      JSON.stringify(recordToolCall.mock.calls);

    it('un comando que lleva el token queda redactado en el resumen', async () => {
      const { service, recordToolCall } = setup();
      await service.exec(
        WORKSPACE,
        {
          command: `export CLAUDE_CODE_OAUTH_TOKEN=${TOKEN} && claude`,
          timeoutSeconds: 30,
        },
        new AbortController().signal,
      );

      const call = recordToolCall.mock.calls[0]?.[0] as { planSummary: string };
      expect(call.planSummary).toContain('CLAUDE_CODE_OAUTH_TOKEN=[omitido]');
      expect(summaries(recordToolCall)).not.toContain('TokenDePrueba');
      expect(summaries(recordToolCall)).not.toContain('sk-ant-oat');
    });

    it('un token en el límite de los 120 caracteres tampoco se filtra a medias', async () => {
      const { service, recordToolCall } = setup();
      await service.exec(
        WORKSPACE,
        { command: `echo ${'x'.repeat(95)} ${TOKEN}`, timeoutSeconds: 30 },
        new AbortController().signal,
      );
      expect(summaries(recordToolCall)).not.toContain('sk-ant-oat');
    });

    it('un servidor en segundo plano tampoco', async () => {
      const { service, recordToolCall } = setup();
      await service.startService(WORKSPACE, {
        command: `ANTHROPIC_API_KEY=${TOKEN} node server.js`,
        port: 3000,
      });
      expect(summaries(recordToolCall)).not.toContain('sk-ant-oat');
      expect(summaries(recordToolCall)).toContain(
        'ANTHROPIC_API_KEY=[omitido]',
      );
    });
  });
});
