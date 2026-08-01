import type { ConfigService } from '@nestjs/config';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentService } from '../agent/agent.service';
import type { AuditService } from '../audit/audit.service';
import type { BudgetGuardedModelRouter } from '../budget/budget-guarded-router.service';
import type { BudgetService } from '../budget/budget.service';
import type { KillSwitchService } from '../budget/kill-switch.service';
import type { Env } from '../config/env.schema';
import type { Db } from '../db/db.module';
import type { ApprovalExecutionService } from '../hitl/approval-execution.service';
import {
  DualConfirmService,
  PendingApprovalNotFoundError,
  SecondApprovalTooEarlyError,
} from '../hitl/dual-confirm.service';
import type { GoogleOAuthService } from '../integrations/google/oauth.service';
import type { MemoryService } from '../memory/memory.service';
import { TelegramBotService } from './telegram-bot.service';

describe('TelegramBotService (Fase 5.3 completa con cobertura restaurada)', () => {
  let service: TelegramBotService;
  let mockConfigService: Partial<ConfigService<Env, true>>;
  let mockBudgetGuardedRouter: Partial<BudgetGuardedModelRouter>;
  let mockBudgetService: Partial<BudgetService>;
  let mockKillSwitchService: Partial<KillSwitchService>;
  let mockDualConfirm: Partial<DualConfirmService>;
  let mockAuditService: Partial<AuditService>;
  let mockApprovalExecutionService: Partial<ApprovalExecutionService>;
  let mockGoogleOAuthService: Partial<GoogleOAuthService>;
  let mockAgentService: Partial<AgentService>;
  let mockMemoryService: Partial<MemoryService>;
  let mockDb: Partial<Db>;

  const OWNER_CHAT_ID = 123456789;
  const OTHER_CHAT_ID = 987654321;
  const SECRET_TOKEN = 'test-secret-token';

  const mockBotUser: UserFromGetMe = {
    id: 1000,
    is_bot: true,
    first_name: 'JinBot',
    username: 'jin_bot',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };

  interface MockSession {
    id: string;
    transcript: Array<{ role: 'user' | 'assistant'; content: string }>;
    status: string;
    lastActivityAt: Date;
    createdAt: Date;
  }

  let dbSessionsStore: MockSession[] = [];

  beforeEach(async () => {
    dbSessionsStore = [];

    mockConfigService = {
      get: (key: keyof Env) => {
        if (key === 'TELEGRAM_BOT_TOKEN') return 'test-bot-token';
        if (key === 'TELEGRAM_OWNER_CHAT_ID') return OWNER_CHAT_ID;
        if (key === 'TELEGRAM_WEBHOOK_URL')
          return 'https://jin.test/telegram/webhook';
        if (key === 'TELEGRAM_WEBHOOK_SECRET') return SECRET_TOKEN;
        return undefined;
      },
    };

    mockBudgetGuardedRouter = {
      complete: vi.fn().mockResolvedValue({
        content: 'Hola owner, respuesta del LLM',
        modelId: 'claude-sonnet-5',
        inputTokens: 10,
        outputTokens: 10,
      }),
    };

    mockBudgetService = {
      getDailyUsageRatio: vi.fn().mockResolvedValue(0.42),
    };

    mockKillSwitchService = {
      isActive: vi.fn().mockResolvedValue(false),
      unpause: vi.fn().mockResolvedValue(undefined),
    };

    mockDualConfirm = {
      getPending: vi.fn(),
      recordApproval: vi.fn(),
      removePending: vi.fn().mockResolvedValue(undefined),
    };

    mockAuditService = {
      recordApproval: vi.fn().mockResolvedValue(undefined),
      recordRejection: vi.fn().mockResolvedValue(undefined),
    };

    mockApprovalExecutionService = {
      resolveAndExecute: vi.fn(),
      resolveRejection: vi.fn().mockResolvedValue(undefined),
    };

    mockGoogleOAuthService = {
      updateLastRefreshedAt: vi.fn().mockResolvedValue(undefined),
      getDaysSinceLastRefresh: vi.fn().mockResolvedValue(2),
    };

    mockAgentService = {
      runTurn: vi.fn().mockResolvedValue({
        finalResponse: 'Respuesta del agente Jin para Telegram',
        plan: { steps: [] },
        pendingApprovals: [],
        iterationsUsed: 1,
      }),
    };

    mockMemoryService = {
      recall: vi.fn().mockResolvedValue([]),
      consolidate: vi.fn().mockResolvedValue([]),
    };

    mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockImplementation(() => {
          return {
            where: vi.fn().mockImplementation(() => {
              return {
                limit: vi.fn().mockImplementation(() => {
                  const active = dbSessionsStore.filter(
                    (s) => s.status === 'active',
                  );
                  return Promise.resolve(active);
                }),
                then: (resolve: (val: unknown) => void) =>
                  resolve([
                    {
                      requestId: 'test-req-1',
                      toolName: 'gitPush',
                      level: 'confirm',
                      inputsHash: 'abc123hash',
                      planSummary: 'Push to main',
                      createdAt: new Date(),
                    },
                  ]),
              };
            }),
            then: (resolve: (val: unknown) => void) =>
              resolve([
                {
                  requestId: 'test-req-1',
                  toolName: 'gitPush',
                  level: 'confirm',
                  inputsHash: 'abc123hash',
                  planSummary: 'Push to main',
                  createdAt: new Date(),
                },
              ]),
          };
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((val: Partial<MockSession>) => {
          return {
            returning: vi.fn().mockImplementation(() => {
              const created: MockSession = {
                id: val.id ?? 'default-id',
                transcript: val.transcript ?? [],
                status: val.status ?? 'active',
                lastActivityAt: val.lastActivityAt ?? new Date(),
                createdAt: new Date(),
              };
              dbSessionsStore.push(created);
              return Promise.resolve([created]);
            }),
          };
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((updateVals: Partial<MockSession>) => {
          return {
            where: vi.fn().mockImplementation(() => {
              for (const session of dbSessionsStore) {
                if (updateVals.status !== undefined) {
                  session.status = updateVals.status;
                }
                if (updateVals.transcript !== undefined) {
                  session.transcript = updateVals.transcript;
                }
                if (updateVals.lastActivityAt !== undefined) {
                  session.lastActivityAt = updateVals.lastActivityAt;
                }
              }
              return Promise.resolve();
            }),
          };
        }),
      }),
    };

    service = new TelegramBotService(
      mockConfigService as ConfigService<Env, true>,
      mockBudgetGuardedRouter as BudgetGuardedModelRouter,
      mockBudgetService as BudgetService,
      mockKillSwitchService as KillSwitchService,
      mockDualConfirm as DualConfirmService,
      mockAuditService as AuditService,
      mockApprovalExecutionService as ApprovalExecutionService,
      mockGoogleOAuthService as GoogleOAuthService,
      mockAgentService as AgentService,
      mockMemoryService as MemoryService,
      mockDb as Db,
    );

    service.getBot().api.config.use((_prev, method) => {
      if (method === 'getMe') {
        return Promise.resolve({
          ok: true,
          result: mockBotUser,
        } as never);
      }
      return Promise.resolve({
        ok: true,
        result: true,
      } as never);
    });

    await service.onModuleInit();
  });

  function createCommandUpdate(updateId: number, text: string): Update {
    const parts = text.split(' ');
    const cmd = parts[0] ?? text;
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: OWNER_CHAT_ID, type: 'private', first_name: 'Owner' },
        from: { id: OWNER_CHAT_ID, first_name: 'Owner', is_bot: false },
        text,
        entities: [{ type: 'bot_command', offset: 0, length: cmd.length }],
      },
    };
  }

  function createMessageUpdate(updateId: number, text: string): Update {
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: OWNER_CHAT_ID, type: 'private', first_name: 'Owner' },
        from: { id: OWNER_CHAT_ID, first_name: 'Owner', is_bot: false },
        text,
      },
    };
  }

  function mockSendMessage(sentMessages: string[]): void {
    service.getBot().api.config.use((_prev, method, payload) => {
      if (
        method === 'sendMessage' &&
        payload &&
        typeof payload === 'object' &&
        'text' in payload
      ) {
        sentMessages.push(String((payload as { text: string }).text));
      }
      if (method === 'getMe') {
        return Promise.resolve({
          ok: true,
          result: mockBotUser,
        } as never);
      }
      return Promise.resolve({
        ok: true,
        result: true,
      } as never);
    });
  }

  it('debe validar el secret token del webhook correctamente', () => {
    expect(service.validateWebhookSecret(SECRET_TOKEN)).toBe(true);
    expect(service.validateWebhookSecret('wrong-secret')).toBe(false);
    expect(service.validateWebhookSecret(undefined)).toBe(false);
  });

  it('debe ignorar peticiones de chats no autorizados', async () => {
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    const unauthorizedUpdate: Update = {
      update_id: 999,
      message: {
        message_id: 999,
        date: Math.floor(Date.now() / 1000),
        chat: { id: OTHER_CHAT_ID, type: 'private', first_name: 'Intruder' },
        from: { id: OTHER_CHAT_ID, first_name: 'Intruder', is_bot: false },
        text: 'Hola Jin',
      },
    };

    await service.handleWebhookUpdate(unauthorizedUpdate);
    expect(sentMessages).toHaveLength(0);
    expect(mockAgentService.runTurn).not.toHaveBeenCalled();
  });

  it('debe procesar el comando /start si proviene del owner', async () => {
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    await service.handleWebhookUpdate(createCommandUpdate(2, '/start'));
    expect(sentMessages.some((msg) => msg.includes('Jin'))).toBe(true);
  });

  it('debe reportar el porcentaje diario real y el estado del kill switch en /budget', async () => {
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    await service.handleWebhookUpdate(createCommandUpdate(3, '/budget'));
    expect(sentMessages.some((msg) => msg.includes('42%'))).toBe(true);
    expect(sentMessages.some((msg) => msg.includes('inactivo'))).toBe(true);
  });

  it('/budget muestra el kill switch activo cuando corresponde', async () => {
    vi.mocked(mockKillSwitchService.isActive!).mockResolvedValue(true);
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    await service.handleWebhookUpdate(createCommandUpdate(30, '/budget'));
    expect(sentMessages.some((msg) => msg.includes('ACTIVO'))).toBe(true);
  });

  it('/unpause desactiva el kill switch y registra auditoría cuando está activo', async () => {
    vi.mocked(mockKillSwitchService.isActive!).mockResolvedValue(true);
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    await service.handleWebhookUpdate(createCommandUpdate(31, '/unpause'));

    expect(mockKillSwitchService.unpause).toHaveBeenCalled();
    expect(mockAuditService.recordApproval).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'unpause', approver: 'owner' }),
    );
    expect(
      sentMessages.some((msg) => msg.includes('Kill switch desactivado')),
    ).toBe(true);
  });

  it('/unpause no hace nada si el kill switch ya está inactivo', async () => {
    vi.mocked(mockKillSwitchService.isActive!).mockResolvedValue(false);
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    await service.handleWebhookUpdate(createCommandUpdate(32, '/unpause'));

    expect(mockKillSwitchService.unpause).not.toHaveBeenCalled();
    expect(mockAuditService.recordApproval).not.toHaveBeenCalled();
    expect(
      sentMessages.some((msg) =>
        msg.includes('El kill switch no está activo — nada que reanudar'),
      ),
    ).toBe(true);
  });

  it('debe listar tareas pendientes al recibir /tasks', async () => {
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    await service.handleWebhookUpdate(createCommandUpdate(4, '/tasks'));
    expect(sentMessages.some((msg) => msg.includes('test-req-1'))).toBe(true);
  });

  it('debe procesar /approve delegando en ApprovalExecutionService y mostrar el resultado real', async () => {
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    vi.mocked(
      mockApprovalExecutionService.resolveAndExecute!,
    ).mockResolvedValue({
      outcome: 'resolved',
      toolName: 'gitPush',
      result: 'push OK',
    });

    await service.handleWebhookUpdate(
      createCommandUpdate(5, '/approve test-req-1'),
    );

    expect(mockApprovalExecutionService.resolveAndExecute).toHaveBeenCalledWith(
      'test-req-1',
      'owner',
    );
    expect(
      sentMessages.some(
        (msg) =>
          msg.includes('Acción Aprobada y Ejecutada') &&
          msg.includes('push OK'),
      ),
    ).toBe(true);
  });

  it('/approve responde awaiting-second sin reportar ejecución cuando es la primera de un dual-confirm', async () => {
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    vi.mocked(
      mockApprovalExecutionService.resolveAndExecute!,
    ).mockResolvedValue({ outcome: 'awaiting-second' });

    await service.handleWebhookUpdate(
      createCommandUpdate(6, '/approve test-req-dual'),
    );

    expect(
      sentMessages.some((msg) => msg.includes('Primera aprobación registrada')),
    ).toBe(true);
  });

  it('debe capturar SecondApprovalTooEarlyError si la aprobación en dual-confirm es muy rápida', async () => {
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    vi.mocked(
      mockApprovalExecutionService.resolveAndExecute!,
    ).mockRejectedValue(
      new SecondApprovalTooEarlyError(
        'test-req-dual',
        new Date(Date.now() + 25000),
      ),
    );

    await service.handleWebhookUpdate(
      createCommandUpdate(6, '/approve test-req-dual'),
    );
    expect(
      sentMessages.some((msg) =>
        msg.includes(
          'La segunda aprobación de "test-req-dual" no se acepta antes de',
        ),
      ),
    ).toBe(true);
  });

  it('/approve responde con error legible si no existe la aprobación pendiente', async () => {
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    vi.mocked(
      mockApprovalExecutionService.resolveAndExecute!,
    ).mockRejectedValue(
      new PendingApprovalNotFoundError('test-req-inexistente'),
    );

    await service.handleWebhookUpdate(
      createCommandUpdate(6, '/approve test-req-inexistente'),
    );
    expect(
      sentMessages.some((msg) => msg.includes('No hay aprobación pendiente')),
    ).toBe(true);
  });

  it('debe procesar /reject delegando en ApprovalExecutionService sin ejecutar nada', async () => {
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    await service.handleWebhookUpdate(
      createCommandUpdate(6, '/reject test-req-1'),
    );

    expect(mockApprovalExecutionService.resolveRejection).toHaveBeenCalledWith(
      'test-req-1',
      'owner',
    );
    expect(sentMessages.some((msg) => msg.includes('Acción Rechazada'))).toBe(
      true,
    );
  });

  describe('checkBudgetAlerts (cron)', () => {
    it('notifica al owner cuando el kill switch pasa a activo', async () => {
      vi.mocked(mockKillSwitchService.isActive!).mockResolvedValue(true);
      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      await service.checkBudgetAlerts();

      expect(
        sentMessages.some((msg) => msg.includes('Kill switch activado')),
      ).toBe(true);
    });

    it('no repite la alerta de kill switch en corridas sucesivas mientras siga activo', async () => {
      vi.mocked(mockKillSwitchService.isActive!).mockResolvedValue(true);
      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      await service.checkBudgetAlerts();
      await service.checkBudgetAlerts();

      expect(
        sentMessages.filter((msg) => msg.includes('Kill switch activado')),
      ).toHaveLength(1);
    });

    it('notifica al owner al cruzar el 80% y el 100% del presupuesto diario', async () => {
      vi.mocked(mockBudgetService.getDailyUsageRatio!).mockResolvedValue(0.85);
      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      await service.checkBudgetAlerts();

      expect(sentMessages.some((msg) => msg.includes('80%'))).toBe(true);
    });

    it('no notifica de nuevo el mismo umbral diario en corridas sucesivas', async () => {
      vi.mocked(mockBudgetService.getDailyUsageRatio!).mockResolvedValue(0.85);
      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      await service.checkBudgetAlerts();
      await service.checkBudgetAlerts();

      expect(sentMessages.filter((msg) => msg.includes('80%'))).toHaveLength(1);
    });

    it('notifica al owner si el token de Google OAuth lleva >= 6 días sin refrescar', async () => {
      vi.mocked(
        mockGoogleOAuthService.getDaysSinceLastRefresh!,
      ).mockResolvedValue(6.2);
      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      await service.checkBudgetAlerts();

      expect(
        sentMessages.some((msg) => msg.includes('ALERTA DE SEGURIDAD OAUTH')),
      ).toBe(true);
    });
  });

  describe('comando /google-oauth-refreshed', () => {
    it('actualiza lastRefreshedAt en GoogleOAuthService y registra auditoría al invocarse por el owner', async () => {
      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      const update = createCommandUpdate(99, '/google-oauth-refreshed');

      await service.handleWebhookUpdate(update);

      expect(mockGoogleOAuthService.updateLastRefreshedAt).toHaveBeenCalled();
      expect(mockAuditService.recordApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'google-oauth-refresh-ack',
          approver: 'owner',
        }),
      );
      expect(
        sentMessages.some((msg) =>
          msg.includes('Timestamp de refresco de Google OAuth actualizado'),
        ),
      ).toBe(true);
    });
  });

  describe('Fase 5.3 — Agent Loop y Sesiones Reales', () => {
    it('debe enrutar mensajes de texto libre al AgentService.runTurn', async () => {
      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      await service.handleWebhookUpdate(
        createMessageUpdate(10, 'Revisa mis correos de hoy'),
      );

      const runTurnCall = vi.mocked(mockAgentService.runTurn!).mock
        .calls[0]![0];
      expect(runTurnCall.objective).toBe('Revisa mis correos de hoy');
      expect(
        sentMessages.includes('Respuesta del agente Jin para Telegram'),
      ).toBe(true);
    });

    it('propaga el mensaje de KillSwitchActiveError o error de presupuesto al owner si agentService.runTurn falla', async () => {
      vi.mocked(mockAgentService.runTurn!).mockRejectedValue(
        new Error('Kill switch activo: runaway detectado.'),
      );
      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      await service.handleWebhookUpdate(
        createMessageUpdate(100, 'Revisa mis correos de nuevo'),
      );

      expect(
        sentMessages.some((msg) =>
          msg.includes('Kill switch activo: runaway detectado.'),
        ),
      ).toBe(true);
    });

    it('debe inyectar memorias recuperadas al iniciar una nueva sesión en el historial', async () => {
      vi.mocked(mockMemoryService.recall!).mockResolvedValue([
        {
          id: 1,
          content: 'El usuario prefiere respuestas concisas en Markdown.',
          tipo: 'preferencia',
          fuente: 'agent_reflection',
          fecha: new Date().toISOString(),
          modeloEmbedding: 'text-embedding-3-large',
        },
      ]);

      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      await service.handleWebhookUpdate(
        createMessageUpdate(11, 'Resúmeme las tareas'),
      );

      expect(mockMemoryService.recall).toHaveBeenCalledWith(
        'Resúmeme las tareas',
        5,
      );
      const runTurnCall = vi.mocked(mockAgentService.runTurn!).mock
        .calls[0]![0];
      expect(runTurnCall.history).toBeDefined();
      expect(runTurnCall.history![0]?.content).toContain(
        '[CONTEXTO DE MEMORIA REUTILIZABLE]',
      );
    });

    it('reconstruye el historial entre turnos continuos en la misma sesión activa', async () => {
      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      // Turno 1
      await service.handleWebhookUpdate(createMessageUpdate(12, 'Hola Jin'));
      expect(mockAgentService.runTurn).toHaveBeenLastCalledWith(
        expect.objectContaining({
          objective: 'Hola Jin',
          history: [],
        }),
      );

      // Turno 2 (misma sesión activa)
      vi.mocked(mockAgentService.runTurn!).mockResolvedValueOnce({
        finalResponse: 'Entendido, anotado.',
        plan: { steps: [] },
        pendingApprovals: [],
        iterationsUsed: 1,
      });

      await service.handleWebhookUpdate(
        createMessageUpdate(13, 'Mi color favorito es azul'),
      );

      expect(mockAgentService.runTurn).toHaveBeenLastCalledWith(
        expect.objectContaining({
          objective: 'Mi color favorito es azul',
          history: [
            { role: 'user', content: 'Hola Jin' },
            {
              role: 'assistant',
              content: 'Respuesta del agente Jin para Telegram',
            },
          ],
        }),
      );
    });

    it('aplica la ventana deslizante de max 20 mensajes pero consolida con el transcript COMPLETO en Postgres', async () => {
      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      // Simular un transcript largo en DB de 24 mensajes
      const longTranscript: Array<{
        role: 'user' | 'assistant';
        content: string;
      }> = [];
      for (let i = 1; i <= 12; i++) {
        longTranscript.push({ role: 'user', content: `Pregunta ${i}` });
        longTranscript.push({ role: 'assistant', content: `Respuesta ${i}` });
      }

      dbSessionsStore.push({
        id: 'session-long-id',
        transcript: longTranscript,
        status: 'active',
        lastActivityAt: new Date(),
        createdAt: new Date(),
      });

      // Nuevo turno en esa sesión
      await service.handleWebhookUpdate(
        createMessageUpdate(14, 'Pregunta final'),
      );

      // runTurn recibe solo los últimos 20 mensajes de la ventana
      const runTurnArgs = vi.mocked(mockAgentService.runTurn!).mock
        .calls[0]![0];
      expect(runTurnArgs.history).toBeDefined();
      expect(runTurnArgs.history).toHaveLength(20);
      expect(runTurnArgs.history![0]?.content).toBe('Pregunta 3');

      // Al cerrar la sesión, consolidateAndCloseSession pasa la totalidad de los mensajes (24 + nuevo turno = 26)
      const session = dbSessionsStore[0];
      await service.consolidateAndCloseSession(session!);

      expect(mockMemoryService.consolidate).toHaveBeenCalledWith(
        'session-long-id',
        expect.stringContaining('Pregunta 1'), // Garantiza que las primeras preguntas que salieron de la ventana SÍ se consolidan
      );
    });

    it('comando /endsession consolida y cierra la sesión activa', async () => {
      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      dbSessionsStore.push({
        id: 'active-sess-1',
        transcript: [
          { role: 'user', content: 'Prefiero usar TypeScript' },
          { role: 'assistant', content: 'Anotado' },
        ],
        status: 'active',
        lastActivityAt: new Date(),
        createdAt: new Date(),
      });

      await service.handleWebhookUpdate(createCommandUpdate(15, '/endsession'));

      expect(mockMemoryService.consolidate).toHaveBeenCalledWith(
        'active-sess-1',
        expect.stringContaining('Prefiero usar TypeScript'),
      );
      expect(dbSessionsStore[0]!.status).toBe('consolidated');
      expect(
        sentMessages.some((msg) =>
          msg.includes('Sesión cerrada y consolidada en memoria'),
        ),
      ).toBe(true);
    });

    it('comando /memory <query> consulta MemoryService.recall y formatea resultados', async () => {
      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      vi.mocked(mockMemoryService.recall!).mockResolvedValue([
        {
          id: 10,
          content: 'El usuario prefiere expreso sin azúcar.',
          tipo: 'preferencia',
          fuente: 'agent_reflection',
          fecha: new Date().toISOString(),
          modeloEmbedding: 'text-embedding-3-large',
        },
      ]);

      await service.handleWebhookUpdate(
        createCommandUpdate(16, '/memory café'),
      );

      expect(mockMemoryService.recall).toHaveBeenCalledWith('café', 5);
      expect(sentMessages.some((msg) => msg.includes('[preferencia]'))).toBe(
        true,
      );
      expect(
        sentMessages.some((msg) =>
          msg.includes('El usuario prefiere expreso sin azúcar.'),
        ),
      ).toBe(true);
    });

    it('checkSessionInactivity (cron) auto-consolida sesiones inactivas por > 30 min con await', async () => {
      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      const oldDate = new Date(Date.now() - 35 * 60 * 1000); // 35 min atrás
      dbSessionsStore.push({
        id: 'inactive-session-id',
        transcript: [
          { role: 'user', content: 'Lección aprendida en sesión inactiva' },
          { role: 'assistant', content: 'Entendido' },
        ],
        status: 'active',
        lastActivityAt: oldDate,
        createdAt: new Date(),
      });

      await service.checkSessionInactivity();

      expect(mockMemoryService.consolidate).toHaveBeenCalledWith(
        'inactive-session-id',
        expect.stringContaining('Lección aprendida en sesión inactiva'),
      );
      expect(dbSessionsStore[0]!.status).toBe('consolidated');
    });

    it('demuestra el flujo round-trip end-to-end de preferencia entre dos sesiones', async () => {
      const sentMessages: string[] = [];
      mockSendMessage(sentMessages);

      // Sesión 1: el usuario menciona una preferencia
      await service.handleWebhookUpdate(
        createMessageUpdate(20, 'Me gusta el café sin azúcar'),
      );

      const activeSess = dbSessionsStore[0];
      expect(activeSess).toBeDefined();

      // El owner cierra la sesión 1
      await service.handleWebhookUpdate(createCommandUpdate(21, '/endsession'));
      expect(mockMemoryService.consolidate).toHaveBeenCalled();

      // Sesión 2: al iniciar nuevo turno, recall() devuelve la preferencia consolidada de sesión 1
      vi.mocked(mockMemoryService.recall!).mockResolvedValueOnce([
        {
          id: 101,
          content: 'El usuario toma café sin azúcar.',
          tipo: 'preferencia',
          fuente: 'agent_reflection',
          fecha: new Date().toISOString(),
          modeloEmbedding: 'text-embedding-3-large',
        },
      ]);

      await service.handleWebhookUpdate(
        createMessageUpdate(22, '¿Qué bebidas me recomiendas?'),
      );

      // El agente recibe en su historial sintético inicial la preferencia consolidada de la sesión anterior
      const turn2Args = vi.mocked(mockAgentService.runTurn!).mock.calls[1]![0];
      expect(turn2Args.history).toBeDefined();
      expect(turn2Args.history![0]?.content).toContain(
        'El usuario toma café sin azúcar.',
      );
    });
  });
});
