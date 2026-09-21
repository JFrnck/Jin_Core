/** Puente Claude Code ↔ owner (ADR 0012). */

/** Máximo de opciones por pregunta: más no entra cómodo en un teclado inline. */
export const MAX_OPTIONS = 5;

/** Telegram corta `callback_data` en 64 bytes; `q:<uuid36>:<idx>` cabe holgado. */
export const CALLBACK_PREFIX = 'q';

/**
 * Mensajes `out` permitidos por hora. Un Claude en bucle no puede inundar el
 * móvil del owner: al pasarse, el endpoint responde 429 y no manda nada.
 */
export const MAX_OUT_PER_HOUR = 30;

export interface RelayInboxMessage {
  readonly id: string;
  readonly body: string;
  /** Presente si el owner respondió a una pregunta: el id de esa pregunta. */
  readonly answerTo?: string;
  readonly createdAt: string;
}

export interface RelayAnswer {
  readonly answered: boolean;
  /** La opción elegida, o el texto libre con el que respondió el owner. */
  readonly body?: string;
  readonly answeredAt?: string;
}

/**
 * `callback_data` de un botón: `q:<id de la pregunta>:<índice de la opción>`.
 * Se manda el índice y no el texto porque el texto puede pasarse de 64 bytes.
 */
export function buildCallbackData(questionId: string, index: number): string {
  return `${CALLBACK_PREFIX}:${questionId}:${index}`;
}

export function parseCallbackData(
  data: string,
): { questionId: string; index: number } | null {
  const parts = data.split(':');
  if (parts.length !== 3 || parts[0] !== CALLBACK_PREFIX) return null;

  const questionId = parts[1];
  const index = Number(parts[2]);
  if (
    questionId === undefined ||
    questionId.length === 0 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= MAX_OPTIONS
  ) {
    return null;
  }

  return { questionId, index };
}
