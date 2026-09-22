import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { Env } from '../config/env.schema';
import {
  escapeHtml,
  htmlToPlain,
  markdownToTelegramHtml,
  splitForTelegram,
} from '../telegram/telegram-format';
import { RelayStore } from './relay.store';
import { buildCallbackData, parseCallbackData } from './relay.types';

/** Reintentos del long polling ante un fallo de red o un 409 de rollout. */
const POLL_RETRY_BASE_MS = 2_000;
const POLL_RETRY_MAX_MS = 60_000;

/**
 * Segundo bot de Telegram, SEPARADO del de Jin (ADR 0012): el canal por el que
 * una sesión de Claude Code corriendo en la VM le habla al owner.
 *
 * Por qué un bot aparte y no el de Jin: el chat de Jin es el canal de
 * aprobaciones HITL (regla de oro #7). Un Claude confundido o con una
 * inyección de prompt (lee logs, issues y páginas web todo el día) podría
 * mandar ahí un mensaje que parezca de Jin y empujar al owner a aprobar algo.
 * Con dos chats la confusión es estructuralmente imposible: **este chat no
 * tiene maquinaria de aprobación**, ni siquiera equivocándose.
 *
 * Este servicio NO inyecta `ApprovalExecutionService` ni `DualConfirmService`:
 * resolver una aprobación de Jin desde acá no es "algo que no hacemos", es
 * algo que no se puede hacer.
 *
 * Usa **long polling**, no webhook (el de Jin sí usa webhook): no abre ninguna
 * ruta pública nueva, solo una conexión saliente hacia api.telegram.org.
 */
@Injectable()
export class RelayBotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RelayBotService.name);
  private readonly bot: Bot | null;
  private readonly ownerChatId: number;
  private stopping = false;

  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly store: RelayStore,
  ) {
    const token = this.configService.get<string>('TELEGRAM_RELAY_BOT_TOKEN', {
      infer: true,
    });
    this.ownerChatId = this.configService.get<number>('TELEGRAM_OWNER_CHAT_ID');
    // Sin token el puente queda apagado y el resto de Jin arranca igual (ver
    // `relay.module.ts`): una función nueva y opcional no puede impedir que
    // el sistema entero levante.
    this.bot = token ? new Bot(token) : null;
    if (this.bot) this.setupHandlers(this.bot);
  }

  /** `true` si el puente está configurado y operativo. */
  get enabled(): boolean {
    return this.bot !== null;
  }

  onModuleInit(): void {
    if (!this.bot) {
      this.logger.log(
        'Puente Claude↔owner deshabilitado (sin TELEGRAM_RELAY_BOT_TOKEN).',
      );
      return;
    }
    // `bot.start()` no resuelve hasta que el bot para: lanzarlo sin await a
    // propósito, si no el arranque de Nest se colgaría acá para siempre.
    void this.runPolling();
  }

  /**
   * Sin esto, `stopping` nunca cambiaba y el bucle de reintentos seguía vivo
   * después de apagar el módulo: en un rollout el pod viejo seguiría pidiendo
   * updates —compitiendo con el nuevo por el mismo bot— y los tests dejarían
   * un timer colgado.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.bot?.stop().catch(() => undefined);
  }

  /**
   * Long polling con backoff. Un 409 ("terminated by other getUpdates") es
   * esperable durante un rollout, mientras el pod viejo todavía no murió: se
   * reintenta en vez de dejar el puente muerto hasta el próximo despliegue.
   */
  private async runPolling(): Promise<void> {
    let attempt = 0;
    while (!this.stopping) {
      try {
        await this.bot?.start({
          drop_pending_updates: false,
          onStart: () => {
            attempt = 0;
            this.logger.log('Puente Claude↔owner escuchando (long polling).');
          },
        });
        return; // salida limpia
      } catch (err: unknown) {
        if (this.stopping) return;
        attempt += 1;
        const delay = Math.min(
          POLL_RETRY_MAX_MS,
          POLL_RETRY_BASE_MS * 2 ** (attempt - 1),
        );
        this.logger.warn(
          `Long polling del puente cayó (${err instanceof Error ? err.message : String(err)}). Reintento en ${delay / 1000}s.`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private setupHandlers(bot: Bot): void {
    // Mismo filtro que el bot de Jin: cualquier chat que no sea el del owner
    // se ignora en silencio.
    bot.use(async (ctx: Context, next) => {
      if (ctx.chat?.id !== this.ownerChatId) {
        this.logger.warn(
          `Puente: mensaje ignorado de chat_id no autorizado ${ctx.chat?.id}`,
        );
        return;
      }
      await next();
    });

    bot.command('start', async (ctx) => {
      await ctx.reply(
        '🛠 Puente de Claude Code. Acá te escribe la sesión que corre en la VM.\n\n' +
          'Este chat NO aprueba acciones de Jin: para eso está el otro bot.',
      );
    });

    // Respuesta a una pregunta con botones.
    bot.on('callback_query:data', async (ctx) => {
      const parsed = parseCallbackData(ctx.callbackQuery.data);
      if (!parsed) {
        await ctx.answerCallbackQuery({ text: 'Opción no reconocida.' });
        return;
      }

      const question = await this.store.findOutbound(parsed.questionId);
      const chosen = question?.options?.[parsed.index];
      if (!question || chosen === undefined) {
        await ctx.answerCallbackQuery({ text: 'Esa pregunta ya no existe.' });
        return;
      }

      const existing = await this.store.findAnswer(question.id);
      if (existing) {
        await ctx.answerCallbackQuery({
          text: `Ya respondiste: ${existing.body}`,
        });
        return;
      }

      await this.store.insertInbound({ body: chosen, answerTo: question.id });
      await ctx.answerCallbackQuery({ text: `Enviado: ${chosen}` });

      // Deja el mensaje mostrando la opción elegida y quita los botones, para
      // que no queden pulsables después de haber respondido.
      try {
        await ctx.editMessageText(
          `${markdownToTelegramHtml(question.body)}\n\n<b>→ ${escapeHtml(chosen)}</b>`,
          { parse_mode: 'HTML' },
        );
      } catch {
        // Editar es cosmético: si Telegram lo rechaza, la respuesta ya quedó
        // guardada y Claude la va a leer igual.
      }
    });

    // Texto libre del owner → cola que Claude consulta.
    bot.on('message:text', async (ctx) => {
      const text = ctx.message.text.trim();
      if (text.length === 0) return;

      // Si el owner responde citando una pregunta, se correlaciona con ella;
      // si no, es un mensaje suelto.
      const repliedId = ctx.message.reply_to_message?.message_id;
      const answerTo =
        repliedId !== undefined
          ? await this.findQuestionByTelegramMessageId(repliedId)
          : undefined;

      await this.store.insertInbound({
        body: text,
        ...(answerTo !== undefined ? { answerTo } : {}),
      });
      await ctx.react('👀').catch(() => undefined);
    });
  }

  private async findQuestionByTelegramMessageId(
    messageId: number,
  ): Promise<string | undefined> {
    const questions = await this.store.pendingQuestions();
    return questions.find((q) => q.telegramMessageId === messageId)?.id;
  }

  /**
   * Manda un mensaje de Claude al owner. Devuelve el `message_id` del primer
   * trozo, que es al que se le adjuntan los botones.
   */
  async deliver(input: {
    body: string;
    options?: readonly string[];
    questionId: string;
  }): Promise<number | undefined> {
    if (!this.bot) return undefined;

    const chunks = splitForTelegram(markdownToTelegramHtml(input.body));
    let firstMessageId: number | undefined;

    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      const keyboard =
        isLast && input.options && input.options.length > 0
          ? this.buildKeyboard(input.questionId, input.options)
          : undefined;

      const sent = await this.sendWithPlainFallback(chunk, keyboard);
      firstMessageId ??= sent;
    }

    return firstMessageId;
  }

  private buildKeyboard(
    questionId: string,
    options: readonly string[],
  ): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    options.forEach((label, index) => {
      keyboard.text(label, buildCallbackData(questionId, index)).row();
    });
    return keyboard;
  }

  /**
   * Igual que en el bot de Jin: si Telegram rechaza el HTML (400 "can't parse
   * entities" por una anidación rara del modelo), se reenvía en texto plano.
   * Un problema de formato no puede hacer que el owner se pierda el mensaje.
   */
  private async sendWithPlainFallback(
    html: string,
    keyboard: InlineKeyboard | undefined,
  ): Promise<number | undefined> {
    if (!this.bot) return undefined;
    const options = {
      parse_mode: 'HTML' as const,
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    };

    try {
      const sent = await this.bot.api.sendMessage(
        this.ownerChatId,
        html,
        options,
      );
      return sent.message_id;
    } catch (err: unknown) {
      const description =
        err !== null && typeof err === 'object' && 'description' in err
          ? String(err.description)
          : '';
      if (!description.includes("can't parse entities")) throw err;

      this.logger.warn(
        'Telegram rechazó el HTML del puente; se reenvía como texto plano.',
      );
      const sent = await this.bot.api.sendMessage(
        this.ownerChatId,
        htmlToPlain(html),
        {
          link_preview_options: { is_disabled: true },
          ...(keyboard ? { reply_markup: keyboard } : {}),
        },
      );
      return sent.message_id;
    }
  }
}
