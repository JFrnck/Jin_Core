import { Injectable, Logger } from '@nestjs/common';
import { RelayBotService } from './relay-bot.service';
import { RelayStore } from './relay.store';
import { RelayQuotaExceededError } from './errors';
import type { RelayAnswer, RelayInboxMessage } from './relay.types';

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

    return { id: row.id };
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
