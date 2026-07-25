import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { Update } from 'grammy/types';
import { AuditService } from '../audit/audit.service';
import { BudgetGuardedModelRouter } from '../budget/budget-guarded-router.service';
import { BudgetService } from '../budget/budget.service';
import { KillSwitchService } from '../budget/kill-switch.service';
import type { Env } from '../config/env.schema';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { pendingApprovals } from '../db/schema';
import { ApprovalExecutionService } from '../hitl/approval-execution.service';
import {
  DualConfirmService,
  PendingApprovalNotFoundError,
  SecondApprovalTooEarlyError,
} from '../hitl/dual-confirm.service';
import { GoogleOAuthService } from '../integrations/google/oauth.service';

// Umbrales de alerta diaria (BLUEPRINT 9.6/10.4): 80% y 100%. Se
// notifica una vez por cruce, no en cada barrido del cron.
const DAILY_ALERT_THRESHOLDS = [0.8, 1] as const;

@Injectable()
export class TelegramBotService implements OnModuleInit {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly bot: Bot;
  private readonly ownerChatId: number;
  private readonly webhookUrl?: string;
  private readonly webhookSecret: string;
  // Sesión estable para el chat conversacional (BLUEPRINT 9.6 "per
  // sesión") — un solo owner, un solo chat, así que toda la
  // conversación libre comparte presupuesto de sesión en vez de que
  // cada mensaje sea su propia sesión aislada.
  private readonly chatSessionId = 'telegram-chat';
  // Estado en memoria para no repetir alertas — a diferencia del estado
  // del kill switch (persistido en budget_kill_switch), perder este
  // flag tras un restart solo produce como mucho una alerta duplicada,
  // no una omitida silenciosamente.
  private lastNotifiedKillSwitchActive = false;
  private readonly notifiedDailyThresholdsToday = new Set<number>();
  private lastDailyThresholdResetDate = '';
  private lastOAuthAlertNotifiedDate = '';

  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly budgetGuardedRouter: BudgetGuardedModelRouter,
    private readonly budgetService: BudgetService,
    private readonly killSwitchService: KillSwitchService,
    private readonly dualConfirmService: DualConfirmService,
    private readonly auditService: AuditService,
    private readonly approvalExecutionService: ApprovalExecutionService,
    private readonly googleOAuthService: GoogleOAuthService,
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

  /**
   * Valida si el secret token recibido en los headers del webhook coincide
   * estrictamente con TELEGRAM_WEBHOOK_SECRET.
   */
  public validateWebhookSecret(secretTokenHeader?: string): boolean {
    return secretTokenHeader === this.webhookSecret;
  }

  public async handleWebhookUpdate(update: Update): Promise<void> {
    await this.bot.handleUpdate(update);
  }

  private setupMiddleware(): void {
    // Middleware de autenticación estricta: ignora cualquier mensaje que no venga del owner
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

  private setupHandlers(): void {
    // Comando /start
    this.bot.command('start', async (ctx) => {
      await ctx.reply(
        '🤖 *YORMUNGANDER* — Orquestador de Agentes Personal\n\nSistema activo y listo para procesar instrucciones.',
        { parse_mode: 'Markdown' },
      );
    });

    // Comando /status
    this.bot.command('status', async (ctx) => {
      await ctx.reply(
        '✅ *Estado del Sistema*\n\n' +
          '- *yormun-core*: En línea\n' +
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

    // Comando /budget (Fase 4.1)
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

    // Comando /unpause (BLUEPRINT 9.6: "requiere unpause manual con
    // comando /unpause que a su vez es confirm"). El "confirm" HITL acá
    // lo satisface el propio middleware de auth: solo el owner
    // autenticado por chat_id llega a este handler — no hay un LLM
    // proponiendo el unpause que necesite una aprobación separada.
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

    // Handler de mensajes de texto libre (conversacional vía
    // BudgetGuardedModelRouter — nunca ModelRouterService directo, así
    // pasa por el chequeo de presupuesto/kill switch, BLUEPRINT 9.6).
    this.bot.on('message:text', async (ctx) => {
      const text = ctx.message.text;
      if (text.startsWith('/')) {
        return; // Ya procesado por los command handlers
      }

      try {
        const response = await this.budgetGuardedRouter.complete(
          'chat_conversational',
          {
            systemPrompt:
              'Eres Yormun, un orquestador de agentes inteligente y conciso.',
            messages: [{ role: 'user', content: text }],
            maxOutputTokens: 2000,
            temperature: 0.7,
          },
          undefined,
          this.chatSessionId,
        );

        await ctx.reply(response.content);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Error en respuesta conversacional: ${msg}`);
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
      if (err instanceof PendingApprovalNotFoundError) {
        await ctx.reply(`❌ ${err.message}`);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`⚠️ Error al procesar aprobación: ${msg}`);
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
      if (err instanceof PendingApprovalNotFoundError) {
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

  /**
   * Alertas de kill switch y presupuesto diario (BLUEPRINT 9.6/10.4).
   * Vive acá (no en src/budget/) para evitar un import circular entre
   * BudgetModule y TelegramModule — Telegram ya importa Budget (para
   * `BudgetGuardedModelRouter` y este mismo comando `/unpause`), así que
   * hacer el polling de este lado es la única dirección sin ciclos. Ver
   * STATUS.md Fase 4.1 para la decisión completa.
   */
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
    // Se actualiza siempre (no solo al notificar) para poder notificar
    // de nuevo si se reactiva tras un /unpause.
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
