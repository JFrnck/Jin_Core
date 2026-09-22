import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { relayMessages, type RelayMessageRow } from '../db/schema';
import { MAX_OUT_PER_HOUR } from './relay.types';

/**
 * Único punto que toca `relay_messages` (ADR 0012). Está separado del servicio
 * a propósito: `RelayService` (lo que expone el controller) y `RelayBotService`
 * (lo que escucha Telegram) necesitan ambos leer y escribir, y si se inyectaran
 * entre sí Nest no podría resolver el ciclo. Los dos dependen de este store y
 * de nada más.
 */
@Injectable()
export class RelayStore {
  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  /** Mensaje o pregunta de Claude hacia el owner. */
  async insertOutbound(input: {
    body: string;
    options?: readonly string[];
  }): Promise<RelayMessageRow> {
    const [row] = await this.db
      .insert(relayMessages)
      .values({
        direction: 'out',
        body: input.body,
        ...(input.options !== undefined ? { options: [...input.options] } : {}),
      })
      .returning();

    if (!row) throw new Error('No se pudo registrar el mensaje del relay.');
    return row;
  }

  /** Guarda el `message_id` de Telegram para poder editar el mensaje después. */
  async attachTelegramMessageId(id: string, messageId: number): Promise<void> {
    await this.db
      .update(relayMessages)
      .set({ telegramMessageId: messageId })
      .where(eq(relayMessages.id, id));
  }

  /** Mensaje del owner hacia Claude (texto libre o respuesta a una pregunta). */
  async insertInbound(input: {
    body: string;
    answerTo?: string;
  }): Promise<RelayMessageRow> {
    const [row] = await this.db
      .insert(relayMessages)
      .values({
        direction: 'in',
        body: input.body,
        ...(input.answerTo !== undefined ? { answerTo: input.answerTo } : {}),
      })
      .returning();

    if (!row) throw new Error('No se pudo registrar la respuesta del owner.');
    return row;
  }

  /**
   * Los `in` pendientes, más viejos primero, marcándolos consumidos **en la
   * misma sentencia**: si dos lecturas concurrentes llegan a la vez, solo una
   * se lleva cada fila. Con un SELECT y un UPDATE aparte, Claude podría
   * procesar dos veces la misma instrucción del owner.
   */
  async consumePending(): Promise<RelayMessageRow[]> {
    return this.db
      .update(relayMessages)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(relayMessages.direction, 'in'),
          isNull(relayMessages.consumedAt),
        ),
      )
      .returning();
  }

  async findOutbound(id: string): Promise<RelayMessageRow | undefined> {
    const [row] = await this.db
      .select()
      .from(relayMessages)
      .where(and(eq(relayMessages.id, id), eq(relayMessages.direction, 'out')))
      .limit(1);
    return row;
  }

  /** La respuesta a una pregunta, si ya llegó. La más reciente gana. */
  async findAnswer(questionId: string): Promise<RelayMessageRow | undefined> {
    const [row] = await this.db
      .select()
      .from(relayMessages)
      .where(
        and(
          eq(relayMessages.direction, 'in'),
          eq(relayMessages.answerTo, questionId),
        ),
      )
      .orderBy(desc(relayMessages.createdAt))
      .limit(1);
    return row;
  }

  /** Preguntas sin responder, para que el bot sepa qué botones siguen vivos. */
  async pendingQuestions(): Promise<RelayMessageRow[]> {
    return this.db
      .select()
      .from(relayMessages)
      .where(
        and(
          eq(relayMessages.direction, 'out'),
          sql`${relayMessages.options} is not null`,
        ),
      )
      .orderBy(asc(relayMessages.createdAt));
  }

  /** `true` si ya se alcanzó el tope de mensajes salientes de la última hora. */
  async outQuotaExceeded(now: Date = new Date()): Promise<boolean> {
    const since = new Date(now.getTime() - 60 * 60 * 1000);
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(relayMessages)
      .where(
        and(
          eq(relayMessages.direction, 'out'),
          gte(relayMessages.createdAt, since),
        ),
      );

    return (row?.count ?? 0) >= MAX_OUT_PER_HOUR;
  }
}
