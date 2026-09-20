import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { eq } from 'drizzle-orm';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { Update } from 'grammy/types';
import { AgentService } from '../agent/agent.service';
import { AuditService } from '../audit/audit.service';
import { ChainVerificationService } from '../audit/chain-verification.service';
import { BudgetGuardedModelRouter } from '../budget/budget-guarded-router.service';
import { BudgetService } from '../budget/budget.service';
import { KillSwitchService } from '../budget/kill-switch.service';
import type { Env } from '../config/env.schema';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import {
  pendingApprovals,
  telegramSessions,
  type TelegramSessionRow,
} from '../db/schema';
import { ApprovalExecutionService } from '../hitl/approval-execution.service';
import {
  AUTONOMY_MODE_CHANGED_EVENT,
  type AutonomyModeChangedEvent,
} from '../autonomy/autonomy.events';
import { parseModeCommand } from '../autonomy/autonomy.logic';
import { AutonomyService } from '../autonomy/autonomy.service';
import {
  HITL_ACTION_NOTIFIED_EVENT,
  type HitlActionNotifiedEvent,
} from '../hitl/notify.events';
import {
  ApprovalAlreadyResolvedError,
  DualConfirmService,
  PendingApprovalNotFoundError,
  SecondApprovalTooEarlyError,
} from '../hitl/dual-confirm.service';
import {
  HITL_APPROVAL_ABANDONED_EVENT,
  HITL_APPROVAL_ESCALATED_EVENT,
  HITL_APPROVAL_STUCK_EVENT,
  type HitlApprovalTimeoutEvent,
} from '../hitl/timeout.service';
import { GoogleOAuthService } from '../integrations/google/oauth.service';
import { MemoryService } from '../memory/memory.service';
import type { MemoryEntry } from '../memory/memory.types';
import type { ModelMessage } from '../model-provider/model-provider.types';

// Umbrales de alerta diaria (BLUEPRINT 9.6/10.4): 80% y 100%.
const DAILY_ALERT_THRESHOLDS = [0.8, 1] as const;

// Constantes de ciclo de vida de sesión (Fase 5.3)
const SESSION_INACTIVITY_MS = 30 * 60 * 1000; // 30 minutos
const MAX_SESSION_MESSAGES = 30; // Conteo máximo de mensajes en transcript antes de auto-consolidar
const MAX_WINDOW_MESSAGES = 20; // Tamaño máximo de la ventana deslizante enviada al agente

@Injectable()
export class TelegramBotService implements OnModuleInit {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly bot: Bot;
  private readonly ownerChatId: number;
  private readonly webhookUrl?: string;
  private readonly webhookSecret: string;
  private lastNotifiedKillSwitchActive = false;
  private readonly notifiedDailyThresholdsToday = new Set<number>();
  private lastDailyThresholdResetDate = '';
  private lastOAuthAlertNotifiedDate = '';
  private lastNotifiedChainLocked = false;

  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly budgetGuardedRouter: BudgetGuardedModelRouter,
    private readonly budgetService: BudgetService,
    private readonly killSwitchService: KillSwitchService,
    private readonly dualConfirmService: DualConfirmService,
    private readonly auditService: AuditService,
    private readonly chainVerificationService: ChainVerificationService,
    private readonly approvalExecutionService: ApprovalExecutionService,
    private readonly googleOAuthService: GoogleOAuthService,
    private readonly agentService: AgentService,
    private readonly memoryService: MemoryService,
    private readonly featureFlagsService: FeatureFlagsService,
    private readonly autonomyService: AutonomyService,
    @Inject(DB_CONNECTION) private readonly db: Db,
  ) {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    this.ownerChatId = this.configService.get<number>('TELEGRAM_OWNER_CHAT_ID');
    this.webhookUrl = this.configService.get<string>('TELEGRAM_WEBHOOK_URL', {
      infer: true,
    });
    this.webhookSecret = this.configService.get<string>(
      'TELEGRAM_WEBHOOK_SECRET',
    );

    this.bot = new Bot(token);
    this.setupMiddleware();
    this.setupHandlers();
  }

  async onModuleInit(): Promise<void> {
    try {
      if (!this.bot.isInited()) {
        await this.bot.init();
        this.logger.log(
          `Bot de Telegram inicializado como @${this.bot.botInfo.username}`,
        );
      }

      if (this.webhookUrl) {
        await this.bot.api.setWebhook(this.webhookUrl, {
          secret_token: this.webhookSecret,
        });
        this.logger.log(
          `Webhook de Telegram configurado en: ${this.webhookUrl} (con secret_token)`,
        );
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Error al inicializar/configurar bot de Telegram: ${errorMsg}`,
      );
    }
  }

  public getBot(): Bot {
    return this.bot;
  }

  public validateWebhookSecret(secretTokenHeader?: string): boolean {
    return secretTokenHeader === this.webhookSecret;
  }

  public async handleWebhookUpdate(update: Update): Promise<void> {
    await this.bot.handleUpdate(update);
  }

  private setupMiddleware(): void {
    this.bot.use(async (ctx: Context, next) => {
      if (ctx.chat?.id !== this.ownerChatId) {
        this.logger.warn(
          `Intento de acceso no autorizado desde chat_id ${ctx.chat?.id}`,
        );
        return;
      }
      await next();
    });
  }

  public async getActiveDbSession(): Promise<TelegramSessionRow | null> {
    const [session] = await this.db
      .select()
      .from(telegramSessions)
      .where(eq(telegramSessions.status, 'active'))
      .limit(1);
    return session ?? null;
  }

  private formatTranscriptForConsolidation(
    transcript: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): string {
    return transcript
      .map(
        (turn) =>
          `${turn.role === 'user' ? 'Usuario' : 'Jin'}: ${turn.content}`,
      )
      .join('\n\n');
  }

  public async consolidateAndCloseSession(
    session: TelegramSessionRow,
  ): Promise<readonly MemoryEntry[]> {
    const fullTranscript = this.formatTranscriptForConsolidation(
      session.transcript ?? [],
    );

    let entries: readonly MemoryEntry[] = [];
    if (fullTranscript.trim().length > 0) {
      try {
        entries = await this.memoryService.consolidate(
          session.id,
          fullTranscript,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Error al consolidar memoria de sesión ${session.id}: ${msg}`,
        );
      }
    }

    await this.db
      .update(telegramSessions)
      .set({ status: 'consolidated', lastActivityAt: new Date() })
      .where(eq(telegramSessions.id, session.id));

    return entries;
  }

  private setupHandlers(): void {
    // Comando /start
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        '🤖 *Jin* — Orquestador de Agentes Personal\n\nSistema activo y listo para procesar instrucciones.',
        { parse_mode: 'Markdown' },
      );
    });

    // Comando /status
    this.bot.command('status', async (ctx) => {
      await ctx.reply(
        '✅ *Estado del Sistema*\n\n' +
          '- *jin-core*: En línea\n' +
          '- *Base de Datos*: Conectada (Postgres + pgvector)\n' +
          '- *Modo Webhook*: Activo',
        { parse_mode: 'Markdown' },
      );
    });

    // Comando /tasks
    this.bot.command('tasks', async (ctx) => {
      await this.handleTasksCommand(ctx);
    });

    // Comando /approve <requestId>
    this.bot.command('approve', async (ctx) => {
      const requestId = ctx.match?.trim();
      if (!requestId) {
        await ctx.reply('⚠️ Uso: `/approve <id>`', { parse_mode: 'Markdown' });
        return;
      }
      await this.processApproval(ctx, requestId);
    });

    // Comando /reject <requestId>
    this.bot.command('reject', async (ctx) => {
      const requestId = ctx.match?.trim();
      if (!requestId) {
        await ctx.reply('⚠️ Uso: `/reject <id>`', { parse_mode: 'Markdown' });
        return;
      }
      await this.processRejection(ctx, requestId);
    });

    // Comando /mode (ADR 0010): interruptor de autonomía del HITL. Solo el
    // owner llega acá (middleware de chat_id). Volver a un modo más
    // restrictivo es inmediato; bajar la protección crea una aprobación
    // dual-confirm que se resuelve con /approve dos veces (>=30 s).
    this.bot.command('mode', async (ctx) => {
      const command = parseModeCommand(ctx.match);
      if (command.kind === 'invalid') {
        await ctx.reply(
          'Uso: /mode (ver estado) · /mode safe · /mode semi [horas] · /mode auto [horas]',
        );
        return;
      }
      if (command.kind === 'status') {
        await ctx.reply(await this.describeAutonomyMode());
        return;
      }
      const result = await this.autonomyService.requestModeChange({
        mode: command.mode,
        ...(command.hours !== undefined ? { hours: command.hours } : {}),
        requestedBy: 'owner:telegram',
      });
      if (result.status === 'applied') {
        await ctx.reply(await this.describeAutonomyMode());
        return;
      }
      await ctx.reply(
        `⏳ Para pasar a modo "${result.mode}" durante ${result.hours} h hace falta DOBLE aprobación (baja la protección del HITL).\n` +
          `1) /approve ${result.requestId}\n` +
          `2) esperá 30 s y repetí /approve ${result.requestId}\n` +
          'Para cancelar: /reject. Mientras tanto sigue el modo actual.',
      );
    });

    // Comando /budget
    this.bot.command('budget', async (ctx) => {
      const ratio = await this.budgetService.getDailyUsageRatio();
      const killSwitchActive = await this.killSwitchService.isActive();
      const percent = Math.min(999, Math.round(ratio * 100));

      await ctx.reply(
        `💰 *Presupuesto diario*: ${percent}% consumido.\n` +
          `🔌 *Kill switch*: ${killSwitchActive ? '🔴 ACTIVO — usa /unpause' : '🟢 inactivo'}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Comando /unpause
    this.bot.command('unpause', async (ctx) => {
      if (!(await this.killSwitchService.isActive())) {
        await ctx.reply(
          'ℹ️ El kill switch no está activo — nada que reanudar.',
        );
        return;
      }

      await this.killSwitchService.unpause();
      await this.auditService.recordApproval({
        requestId: randomUUID(),
        approver: 'owner',
        toolName: 'unpause',
        inputsHash: 'n/a',
      });
      this.lastNotifiedKillSwitchActive = false;

      await ctx.reply(
        '✅ Kill switch desactivado. El sistema puede operar normalmente.',
      );
    });

    // Comando /google-oauth-refreshed
    this.bot.command('google-oauth-refreshed', async (ctx) => {
      await this.googleOAuthService.updateLastRefreshedAt();
      await this.auditService.recordApproval({
        requestId: randomUUID(),
        approver: 'owner',
        toolName: 'google-oauth-refresh-ack',
        inputsHash: 'n/a',
      });
      await ctx.reply(
        '✅ Timestamp de refresco de Google OAuth actualizado. Contador reiniciado.',
      );
    });

    // Comando /endsession (Fase 5.3)
    this.bot.command('endsession', async (ctx) => {
      const session = await this.getActiveDbSession();
      if (!session) {
        await ctx.reply('ℹ️ No hay ninguna sesión activa en este momento.');
        return;
      }
      await this.consolidateAndCloseSession(session);
      await ctx.reply(
        '✅ *Sesión cerrada y consolidada en memoria*. Las lecciones y preferencias han sido guardadas.',
        { parse_mode: 'Markdown' },
      );
    });

    // Comando /memory <query> (Fase 5.3)
    this.bot.command('memory', async (ctx) => {
      const query = ctx.match?.trim();
      if (!query) {
        await ctx.reply('⚠️ Uso: `/memory <búsqueda>`', {
          parse_mode: 'Markdown',
        });
        return;
      }
      try {
        const memories = await this.memoryService.recall(query, 5);
        if (memories.length === 0) {
          await ctx.reply(
            '🧠 *Memoria de Jin*: No se encontraron recuerdos relevantes para la consulta.',
            { parse_mode: 'Markdown' },
          );
          return;
        }
        const formatted = memories
          .map((m, idx) => `${idx + 1}. 📌 *[${m.tipo}]* ${m.content}`)
          .join('\n\n');
        await ctx.reply(
          `🧠 *Recuerdos Encontrados (${memories.length})*:\n\n${formatted}`,
          { parse_mode: 'Markdown' },
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`⚠️ Error al consultar memoria: ${msg}`);
      }
    });

    // Handler para botones inline CallbackQuery
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const [action, requestId] = data.split(':');

      if (!requestId) {
        await ctx.answerCallbackQuery({ text: 'Acción no válida' });
        return;
      }

      if (action === 'approve') {
        await ctx.answerCallbackQuery();
        await this.processApproval(ctx, requestId);
      } else if (action === 'reject') {
        await ctx.answerCallbackQuery();
        await this.processRejection(ctx, requestId);
      } else if (action === 'details') {
        await ctx.answerCallbackQuery();
        await this.showTaskDetails(ctx, requestId);
      }
    });

    // Handler de texto libre: agent loop + memoria (Fase 5.3)
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith('/')) {
        return;
      }

      // Fase 9.5: apaga solo el chat libre (turno de agente), nunca los
      // comandos /approve /reject (setupMiddleware/setupHandlers los
      // registra aparte) -- un flag jamás puede bloquear el canal de
      // aprobación HITL en sí, solo la conversación.
      if (!this.featureFlagsService.isIntegrationEnabled('telegram')) {
        await ctx.reply(
          'El chat conversacional está desactivado temporalmente.',
        );
        return;
      }

      try {
        let session = await this.getActiveDbSession();
        const now = Date.now();
        const isInactive =
          session &&
          now - new Date(session.lastActivityAt).getTime() >
            SESSION_INACTIVITY_MS;
        const isTooLong =
          session &&
          Array.isArray(session.transcript) &&
          session.transcript.length >= MAX_SESSION_MESSAGES;

        if (session && (isInactive || isTooLong)) {
          await this.consolidateAndCloseSession(session);
          session = null;
        }

        if (!session) {
          const newSessionId = randomUUID();
          let initialTranscript: Array<{
            role: 'user' | 'assistant';
            content: string;
          }> = [];

          try {
            const memories = await this.memoryService.recall(text, 5);
            if (memories.length > 0) {
              const formattedMemories = memories
                .map((m) => `- [${m.tipo}] ${m.content}`)
                .join('\n');
              initialTranscript = [
                {
                  role: 'user',
                  content: `[CONTEXTO DE MEMORIA REUTILIZABLE]:\n${formattedMemories}`,
                },
                {
                  role: 'assistant',
                  content:
                    'Entendido. Utilizaré este contexto de memoria para guiar mis respuestas.',
                },
              ];
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(
              `Error al recuperar memoria para el turno: ${msg}`,
            );
          }

          const [created] = await this.db
            .insert(telegramSessions)
            .values({
              id: newSessionId,
              transcript: initialTranscript,
              status: 'active',
              lastActivityAt: new Date(),
            })
            .returning();
          if (!created) {
            throw new Error(
              'INSERT a telegram_sessions no devolvió la fila creada.',
            );
          }
          session = created;
        }

        const currentTranscript =
          (session.transcript as Array<{
            role: 'user' | 'assistant';
            content: string;
          }>) ?? [];

        let hasSyntheticMemory = false;
        if (
          currentTranscript.length >= 2 &&
          currentTranscript[0]?.content.startsWith(
            '[CONTEXTO DE MEMORIA REUTILIZABLE]',
          )
        ) {
          hasSyntheticMemory = true;
        }

        let windowTurns = currentTranscript;
        if (hasSyntheticMemory) {
          const syntheticPair = currentTranscript.slice(0, 2);
          const rest = currentTranscript.slice(2);
          const recentRest = rest.slice(-MAX_WINDOW_MESSAGES);
          windowTurns = [...syntheticPair, ...recentRest];
        } else {
          windowTurns = currentTranscript.slice(-MAX_WINDOW_MESSAGES);
        }

        const history: ModelMessage[] = windowTurns.map((t) => ({
          role: t.role,
          content: t.content,
        }));

        const turnResult = await this.agentService.runTurn({
          sessionId: session.id,
          objective: text,
          history,
        });

        const updatedTranscript = [
          ...currentTranscript,
          { role: 'user' as const, content: text },
          { role: 'assistant' as const, content: turnResult.finalResponse },
        ];

        await this.db
          .update(telegramSessions)
          .set({
            transcript: updatedTranscript,
            lastActivityAt: new Date(),
          })
          .where(eq(telegramSessions.id, session.id));

        await ctx.reply(turnResult.finalResponse);

        if (turnResult.pendingApprovals.length > 0) {
          const approvalMsg = turnResult.pendingApprovals
            .map(
              (pa) =>
                `⚠️ *Acción diferida*: \`${pa.toolName}\` (requestId: \`${pa.requestId}\`). Usa /approve ${pa.requestId} o /tasks para aprobar.`,
            )
            .join('\n');
          await ctx.reply(approvalMsg, { parse_mode: 'Markdown' });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Error en respuesta del agente: ${msg}`);
        await ctx.reply(`⚠️ ${msg}`);
      }
    });
  }

  private async handleTasksCommand(ctx: Context): Promise<void> {
    const pendingList = await this.db.select().from(pendingApprovals);

    if (pendingList.length === 0) {
      await ctx.reply('🎉 No hay aprobaciones pendientes.');
      return;
    }

    await ctx.reply(`📋 *Aprobaciones Pendientes (${pendingList.length})*:`, {
      parse_mode: 'Markdown',
    });

    for (const item of pendingList) {
      const keyboard = new InlineKeyboard()
        .text('✅ Aprobar', `approve:${item.requestId}`)
        .text('❌ Rechazar', `reject:${item.requestId}`)
        .row()
        .text('🔍 Ver detalles', `details:${item.requestId}`);

      const text =
        `📌 *Solicitud*: \`${item.requestId}\`\n` +
        `- *Herramienta*: \`${item.toolName}\`\n` +
        `- *Nivel HITL*: \`${item.level}\`\n` +
        `- *Plan*: ${item.planSummary ?? 'Sin resumen'}`;

      await ctx.reply(text, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    }
  }

  private async processApproval(
    ctx: Context,
    requestId: string,
  ): Promise<void> {
    try {
      const outcome = await this.approvalExecutionService.resolveAndExecute(
        requestId,
        'owner',
      );

      if (outcome.outcome === 'awaiting-second') {
        await ctx.reply(
          `⏳ *Primera aprobación registrada* para \`${requestId}\`.\n` +
            `Por favor, envíe la segunda aprobación pasados 30 segundos.`,
          { parse_mode: 'Markdown' },
        );
        return;
      }

      await ctx.reply(
        `✅ *Acción Aprobada y Ejecutada* (\`${requestId}\`).\n` +
          `Resultado: ${String(outcome.result)}`,
        {
          parse_mode: 'Markdown',
        },
      );
    } catch (err: unknown) {
      if (err instanceof SecondApprovalTooEarlyError) {
        await ctx.reply(`⚠️ ${err.message}`);
        return;
      }
      if (
        err instanceof PendingApprovalNotFoundError ||
        err instanceof ApprovalAlreadyResolvedError
      ) {
        await ctx.reply(`❌ ${err.message}`);
        return;
      }
      // El executor falló tras aprobar (issue #36): la acción NO ocurrió y la
      // aprobación sigue pendiente -- hay que decírselo, no solo "error".
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(
        `⚠️ Error al ejecutar la acción aprobada: ${msg}\n` +
          `La acción NO se completó y la aprobación sigue pendiente (/tasks). ` +
          `No se reintenta sola: aprobala de nuevo si querés reintentar.`,
      );
    }
  }

  private async processRejection(
    ctx: Context,
    requestId: string,
  ): Promise<void> {
    try {
      await this.approvalExecutionService.resolveRejection(requestId, 'owner');

      await ctx.reply(
        `❌ *Acción Rechazada* (\`${requestId}\`). Registrado en audit log.`,
        {
          parse_mode: 'Markdown',
        },
      );
    } catch (err: unknown) {
      if (
        err instanceof PendingApprovalNotFoundError ||
        err instanceof ApprovalAlreadyResolvedError
      ) {
        await ctx.reply(`❌ ${err.message}`);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`⚠️ Error al procesar rechazo: ${msg}`);
    }
  }

  private async showTaskDetails(
    ctx: Context,
    requestId: string,
  ): Promise<void> {
    const pending = await this.dualConfirmService.getPending(requestId);
    if (!pending) {
      await ctx.reply(`❌ No se encontró la tarea \`${requestId}\`.`, {
        parse_mode: 'Markdown',
      });
      return;
    }

    const details =
      `🔍 *Detalles de Aprobación Pendiente*\n\n` +
      `- *ID*: \`${pending.requestId}\`\n` +
      `- *Herramienta*: \`${pending.toolName}\`\n` +
      `- *Nivel HITL*: \`${pending.level}\`\n` +
      `- *Hash Inputs*: \`${pending.inputsHash}\`\n` +
      `- *Plan*: ${pending.planSummary ?? 'Sin plan summary'}\n` +
      `- *Creado*: \`${pending.createdAt.toISOString()}\`\n` +
      (pending.firstApprovedAt
        ? `- *1ª Aprobación*: \`${pending.firstApprovedAt.toISOString()}\` por \`${pending.firstApprover}\`\n`
        : '');

    await ctx.reply(details, { parse_mode: 'Markdown' });
  }

  @Cron('*/5 * * * *')
  async checkBudgetAlerts(): Promise<void> {
    try {
      await this.checkKillSwitchAlert();
      await this.checkDailyBudgetAlert();
      await this.checkOAuthAlert();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error chequeando alertas de budget/oauth: ${msg}`);
    }
  }

  /**
   * docs/RECOMENDACIONES.md #11: `ChainVerificationService.verifyDaily()`
   * antes solo lo logueaba ("Alerta Telegram real: Fase 2.4... por ahora
   * solo el log") — fase cerrada hace semanas, nunca recableada. Polling,
   * no evento (mismo criterio que `checkKillSwitchAlert`, comentario en
   * `kill-switch.service.ts`): es un estado booleano persistente, no un
   * suceso puntual — evita el import circular AuditModule→TelegramModule.
   */
  @Cron('*/5 * * * *')
  async checkAuditIntegrityAlert(): Promise<void> {
    try {
      const locked = await this.chainVerificationService.isLocked();
      if (locked && !this.lastNotifiedChainLocked) {
        await this.bot.api.sendMessage(
          this.ownerChatId,
          '🔴 *Audit log bloqueado* — se detectó corrupción en la cadena de auditoría. ' +
            'Todas las escrituras de audit log están rechazadas hasta intervención manual.',
          { parse_mode: 'Markdown' },
        );
      }
      this.lastNotifiedChainLocked = locked;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error chequeando integridad del audit log: ${msg}`);
    }
  }

  /**
   * docs/RECOMENDACIONES.md #11: antes solo `logger.warn` en
   * `TimeoutService` ("notificación real llega en Fase 2.4"). Escucha
   * `HITL_APPROVAL_ESCALATED_EVENT` (mismo mecanismo que
   * `pending-approval:new` en `realtime.gateway.ts`) — el owner tiene 12h
   * más antes del abandono a las 24h.
   */
  @OnEvent(HITL_APPROVAL_ESCALATED_EVENT)
  async onHitlApprovalEscalated(
    event: HitlApprovalTimeoutEvent,
  ): Promise<void> {
    await this.bot.api.sendMessage(
      this.ownerChatId,
      `⚠️ *Aprobación sin responder hace 12h*: \`${event.toolName}\` (${event.requestId}). ` +
        `Se descarta automáticamente a las 24h si no respondés. Usa /tasks para verla.`,
      { parse_mode: 'Markdown' },
    );
  }

  /** Ver el comentario de `onHitlApprovalEscalated` — mismo mecanismo, evento de abandono a las 24h. */
  @OnEvent(HITL_APPROVAL_ABANDONED_EVENT)
  async onHitlApprovalAbandoned(
    event: HitlApprovalTimeoutEvent,
  ): Promise<void> {
    await this.bot.api.sendMessage(
      this.ownerChatId,
      `🔴 *Aprobación ABANDONADA* tras 24h sin respuesta: \`${event.toolName}\` (${event.requestId}). ` +
        'La acción se descartó — nunca se ejecutó.',
      { parse_mode: 'Markdown' },
    );
  }

  /**
   * Issue #36: una aprobación quedó "ejecutándose" y nunca terminó (el
   * proceso murió entre el claim y el final). La acción PUDO haber ocurrido:
   * no se reintenta ni se descarta sola. El barrido es horario, así que este
   * aviso se repite cada hora hasta que el owner actúe.
   */
  @OnEvent(HITL_APPROVAL_STUCK_EVENT)
  async onHitlApprovalStuck(event: HitlApprovalTimeoutEvent): Promise<void> {
    await this.bot.api.sendMessage(
      this.ownerChatId,
      `🔴 *Aprobación TRABADA*: \`${event.toolName}\` (${event.requestId}) quedó ejecutándose y no terminó. ` +
        'La acción pudo o no haberse realizado — verificalo a mano. ' +
        `No se reintenta sola. Cuando lo hayas comprobado, usá /reject ${event.requestId} para limpiarla.`,
      { parse_mode: 'Markdown' },
    );
  }

  private async describeAutonomyMode(): Promise<string> {
    const d = await this.autonomyService.describe();
    if (d.mode === 'supervised') {
      return '🟢 Modo: supervisado (HITL completo). Toda acción que hoy pide aprobación la sigue pidiendo.';
    }
    const hours =
      d.remainingSeconds !== null
        ? `${Math.floor(d.remainingSeconds / 3600)} h ${Math.floor((d.remainingSeconds % 3600) / 60)} min`
        : '?';
    const label = d.mode === 'auto' ? 'AUTOMÁTICO' : 'semiautomático';
    const detail =
      d.mode === 'auto'
        ? 'Lo que pedía 1 aprobación se ejecuta y te avisa. Lo dual-confirm sigue pidiendo 2 aprobaciones.'
        : `Se ejecuta y te avisa, salvo: ${d.guardedInSemiAuto.join(', ')} (siguen pidiendo aprobación). Lo dual-confirm sigue igual.`;
    return `🟠 Modo: ${label} — vuelve solo a supervisado en ${hours}.\n${detail}\nPara volver ya: /mode safe`;
  }

  /** ADR 0010: cada cambio de modo se avisa al owner (aprobado, caducó, freno de emergencia...). */
  @OnEvent(AUTONOMY_MODE_CHANGED_EVENT)
  async onAutonomyModeChanged(event: AutonomyModeChangedEvent): Promise<void> {
    const why: Record<AutonomyModeChangedEvent['reason'], string> = {
      approved: 'aprobado con doble confirmación',
      downgrade: 'lo pediste vos',
      expired: 'CADUCÓ',
      'circuit-breaker':
        'FRENO DE EMERGENCIA: se autoejecutaron demasiadas acciones en 1 h',
    };
    await this.bot.api.sendMessage(
      this.ownerChatId,
      `${event.mode === 'supervised' ? '🟢' : '🟠'} Modo de autonomía: ${event.previousMode} → ${event.mode} (${why[event.reason]}).`,
    );
  }

  /**
   * Notificación POST-HOC (BLUEPRINT 9.1): una acción `notify` ya se ejecutó.
   * Con un modo de autonomía activo, también dice que NO pidió aprobación y
   * por qué -- nunca se autoejecuta nada en silencio.
   */
  @OnEvent(HITL_ACTION_NOTIFIED_EVENT)
  async onHitlActionNotified(event: HitlActionNotifiedEvent): Promise<void> {
    const relaxed =
      event.relaxedBy !== undefined
        ? ` — se ejecutó SIN pedirte aprobación (${event.relaxedBy})`
        : '';
    await this.bot.api.sendMessage(
      this.ownerChatId,
      `✅ Ejecuté ${event.toolName}${relaxed}. (${event.actor}, id ${event.requestId})`,
    );
  }

  @Cron('*/5 * * * *')
  async checkSessionInactivity(): Promise<void> {
    try {
      const session = await this.getActiveDbSession();
      if (!session) return;
      const now = Date.now();
      const inactiveMs = now - new Date(session.lastActivityAt).getTime();
      if (inactiveMs > SESSION_INACTIVITY_MS) {
        this.logger.log(
          `Cerrando sesión inactiva ${session.id} (${Math.round(inactiveMs / 60000)} min de inactividad)`,
        );
        await this.consolidateAndCloseSession(session);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error en chequeo de inactividad de sesión: ${msg}`);
    }
  }

  private async checkOAuthAlert(): Promise<void> {
    const days = await this.googleOAuthService.getDaysSinceLastRefresh();
    const today = new Date().toISOString().slice(0, 10);

    if (days >= 6 && this.lastOAuthAlertNotifiedDate !== today) {
      this.lastOAuthAlertNotifiedDate = today;
      await this.bot.api.sendMessage(
        this.ownerChatId,
        `⚠️ *ALERTA DE SEGURIDAD OAUTH*: El refresh token de Google OAuth (Testing Mode) ` +
          `caducará pronto. Transcurridos ${days.toFixed(1)} días desde el último refresco ` +
          `manual. Usa /google-oauth-refreshed tras actualizar el token.`,
        { parse_mode: 'Markdown' },
      );
    }
  }

  private async checkKillSwitchAlert(): Promise<void> {
    const isActive = await this.killSwitchService.isActive();

    if (isActive && !this.lastNotifiedKillSwitchActive) {
      await this.bot.api.sendMessage(
        this.ownerChatId,
        '🔴 *Kill switch activado* — consumo runaway detectado. Todos los agentes están pausados. Usa /unpause para reanudar.',
        { parse_mode: 'Markdown' },
      );
    }
    this.lastNotifiedKillSwitchActive = isActive;
  }

  private async checkDailyBudgetAlert(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastDailyThresholdResetDate) {
      this.notifiedDailyThresholdsToday.clear();
      this.lastDailyThresholdResetDate = today;
    }

    const ratio = await this.budgetService.getDailyUsageRatio();

    for (const threshold of DAILY_ALERT_THRESHOLDS) {
      if (
        ratio >= threshold &&
        !this.notifiedDailyThresholdsToday.has(threshold)
      ) {
        this.notifiedDailyThresholdsToday.add(threshold);
        const percent = Math.round(threshold * 100);
        await this.bot.api.sendMessage(
          this.ownerChatId,
          `⚠️ *Presupuesto diario al ${percent}%*` +
            (threshold >= 1
              ? ' — solo tools auto con modelos baratos hasta el reset de las 00:00.'
              : ' — degradando a modelos más baratos automáticamente.'),
          { parse_mode: 'Markdown' },
        );
      }
    }
  }
}
