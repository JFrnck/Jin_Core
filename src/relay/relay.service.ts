import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { markdownToTelegramHtml } from '../telegram/telegram-format';
import { RelayBotService } from './relay-bot.service';
import { RelayStore } from './relay.store';
import { RelayQuotaExceededError } from './errors';
import type {
  RelayAnswer,
  RelayHistoryMessage,
  RelayInboxMessage,
} from './relay.types';

// Mismo patrón que PENDING_APPROVAL_CREATED_EVENT (dual-confirm.service.ts):
// el WebSocket gateway (`src/realtime/`) escucha esto para empujar
// `bridge:new-message` sin polling, tanto para un mensaje que llega de
// Claude (Telegram o el CLI de la VM) como para una respuesta que el owner
// manda desde el dashboard.
export const RELAY_MESSAGE_CREATED_EVENT = 'relay-message.created';

export interface RelayMessageCreatedEvent {
  readonly id: string;
  readonly direction: 'in' | 'out';
}

/**
 * Puente Claude Code ↔ owner (ADR 0012). Lo que expone el controller.
 *
 * Deliberadamente NO inyecta nada de `src/hitl/`: este módulo no puede
 * aprobar, rechazar ni tocar una acción pendiente de Jin. Es una propiedad
 * estructural, verificada por un test, no una convención.
 */
@Injectable()
export class RelayService {
  private readonly logger = new Logger(RelayService.name);

  constructor(
    private readonly store: RelayStore,
    private readonly bot: RelayBotService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  get enabled(): boolean {
    return this.bot.enabled;
  }

  /**
   * Manda un mensaje (o una pregunta con opciones) al owner.
   *
   * La fila se escribe ANTES de entregar: si Telegram falla, queda registrado
   * que Claude intentó decir algo. Al revés, un envío entregado sin registrar
   * dejaría una pregunta sin forma de correlacionar su respuesta.
   */
  async send(input: {
    body: string;
    options?: readonly string[];
  }): Promise<{ id: string }> {
    if (await this.store.outQuotaExceeded()) {
      throw new RelayQuotaExceededError();
    }

    const row = await this.store.insertOutbound(input);

    const messageId = await this.bot.deliver({
      body: input.body,
      questionId: row.id,
      ...(input.options !== undefined ? { options: input.options } : {}),
    });
    if (messageId !== undefined) {
      await this.store.attachTelegramMessageId(row.id, messageId);
    }

    this.eventEmitter.emit(RELAY_MESSAGE_CREATED_EVENT, {
      id: row.id,
      direction: 'out',
    } satisfies RelayMessageCreatedEvent);

    return { id: row.id };
  }

  /**
   * Respuesta del owner desde el dashboard — mismo rol que `insertInbound`
   * cumple hoy para el bot de Telegram (`relay-bot.service.ts`), segundo
   * canal sobre la misma tabla. Sin cuota: a diferencia de `send()`, acá no
   * hay riesgo de que un Claude en bucle inunde nada — es el owner mandando
   * un mensaje él mismo.
   */
  async reply(input: {
    body: string;
    answerTo?: string;
  }): Promise<{ id: string }> {
    const row = await this.store.insertInbound(input);

    this.eventEmitter.emit(RELAY_MESSAGE_CREATED_EVENT, {
      id: row.id,
      direction: 'in',
    } satisfies RelayMessageCreatedEvent);

    return { id: row.id };
  }

  /**
   * Historial para el dashboard — a diferencia de `inbox()`, no consume
   * nada: es solo para que el owner mire la pantalla, no afecta la cola
   * que lee el CLI de la VM.
   */
  async history(limit = 50): Promise<RelayHistoryMessage[]> {
    const rows = await this.store.listRecent(limit);
    return rows.map((row) => ({
      id: row.id,
      direction: row.direction as 'in' | 'out',
      body: row.body,
      bodyHtml: markdownToTelegramHtml(row.body),
      ...(row.options !== null ? { options: row.options } : {}),
      ...(row.answerTo !== null ? { answerTo: row.answerTo } : {}),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /** Mensajes del owner pendientes. Los marca consumidos: no se repiten. */
  async inbox(): Promise<RelayInboxMessage[]> {
    const rows = await this.store.consumePending();
    return rows
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((row) => ({
        id: row.id,
        body: row.body,
        ...(row.answerTo !== null ? { answerTo: row.answerTo } : {}),
        createdAt: row.createdAt.toISOString(),
      }));
  }

  /** Respuesta a una pregunta concreta (modo `--wait` del CLI). */
  async answer(questionId: string): Promise<RelayAnswer> {
    const row = await this.store.findAnswer(questionId);
    if (!row) return { answered: false };
    return {
      answered: true,
      body: row.body,
      answeredAt: row.createdAt.toISOString(),
    };
  }
}
