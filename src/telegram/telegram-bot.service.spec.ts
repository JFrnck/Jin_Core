import type { ConfigService } from '@nestjs/config';
import type { Update, UserFromGetMe } from 'grammy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { TelegramBotService } from './telegram-bot.service';

describe('TelegramBotService', () => {
  let service: TelegramBotService;
  let mockConfigService: Partial<ConfigService<Env, true>>;
  let mockBudgetGuardedRouter: Partial<BudgetGuardedModelRouter>;
  let mockBudgetService: Partial<BudgetService>;
  let mockKillSwitchService: Partial<KillSwitchService>;
  let mockDualConfirm: Partial<DualConfirmService>;
  let mockAuditService: Partial<AuditService>;
  let mockApprovalExecutionService: Partial<ApprovalExecutionService>;
  let mockGoogleOAuthService: Partial<GoogleOAuthService>;
  let mockDb: Partial<Db>;

  const OWNER_CHAT_ID = 123456789;
  const OTHER_CHAT_ID = 987654321;
  const SECRET_TOKEN = 'test-secret-token';

  const mockBotUser: UserFromGetMe = {
    id: 1000,
    is_bot: true,
    first_name: 'YormunBot',
    username: 'yormun_bot',
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

  beforeEach(async () => {
    mockConfigService = {
      get: (key: keyof Env) => {
        if (key === 'TELEGRAM_BOT_TOKEN') return 'test-bot-token';
        if (key === 'TELEGRAM_OWNER_CHAT_ID') return OWNER_CHAT_ID;
        if (key === 'TELEGRAM_WEBHOOK_URL')
          return 'https://yormun.test/telegram/webhook';
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

    mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue([
          {
            requestId: 'test-req-1',
            toolName: 'gitPush',
            level: 'confirm',
            inputsHash: 'abc123hash',
            planSummary: 'Push to main',
            createdAt: new Date(),
          },
        ]),
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
      mockDb as Db,
    );

    // Mock API calls for getMe and setWebhook
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

  it('debe descartar mensajes que no provengan del TELEGRAM_OWNER_CHAT_ID', async () => {
    const handleUpdateSpy = vi.spyOn(service.getBot(), 'handleUpdate');
    const update: Update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: OTHER_CHAT_ID, type: 'private', first_name: 'Intruder' },
        from: { id: OTHER_CHAT_ID, first_name: 'Intruder', is_bot: false },
        text: '/start',
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    };

    await service.handleWebhookUpdate(update);
    expect(handleUpdateSpy).toHaveBeenCalledWith(update);
    expect(mockBudgetGuardedRouter.complete).not.toHaveBeenCalled();
  });

  it('debe procesar el comando /start si proviene del owner', async () => {
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    await service.handleWebhookUpdate(createCommandUpdate(2, '/start'));
    expect(sentMessages.some((msg) => msg.includes('YORMUNGANDER'))).toBe(true);
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
    expect(sentMessages.some((msg) => msg.includes('nada que reanudar'))).toBe(
      true,
    );
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

  it('debe responder usando BudgetGuardedModelRouter al recibir texto libre, con una sessionId estable', async () => {
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    const update: Update = {
      update_id: 7,
      message: {
        message_id: 7,
        date: Math.floor(Date.now() / 1000),
        chat: { id: OWNER_CHAT_ID, type: 'private', first_name: 'Owner' },
        from: { id: OWNER_CHAT_ID, first_name: 'Owner', is_bot: false },
        text: 'Hola Yormun, ¿cómo estás?',
      },
    };

    await service.handleWebhookUpdate(update);
    expect(mockBudgetGuardedRouter.complete).toHaveBeenCalledWith(
      'chat_conversational',
      expect.objectContaining({
        messages: [{ role: 'user', content: 'Hola Yormun, ¿cómo estás?' }],
        maxOutputTokens: 2000,
        temperature: 0.7,
      }),
      undefined,
      expect.any(String),
    );
    expect(sentMessages).toContain('Hola owner, respuesta del LLM');
  });

  it('propaga el mensaje de KillSwitchActiveError/presupuesto al owner en vez de un genérico', async () => {
    vi.mocked(mockBudgetGuardedRouter.complete!).mockRejectedValue(
      new Error('Kill switch activo: runaway detectado.'),
    );
    const sentMessages: string[] = [];
    mockSendMessage(sentMessages);

    const update: Update = {
      update_id: 8,
      message: {
        message_id: 8,
        date: Math.floor(Date.now() / 1000),
        chat: { id: OWNER_CHAT_ID, type: 'private', first_name: 'Owner' },
        from: { id: OWNER_CHAT_ID, first_name: 'Owner', is_bot: false },
        text: 'Hola de nuevo',
      },
    };

    await service.handleWebhookUpdate(update);
    expect(sentMessages.some((msg) => msg.includes('Kill switch activo'))).toBe(
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
});
