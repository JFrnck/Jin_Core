/** Puente Claude Code ↔ owner (ADR 0012). */

/**
 * Máximo de opciones por pregunta. El límite real era "5 entra cómodo en un
 * teclado inline de Telegram" — con el dashboard como segundo canal (sin esa
 * restricción física) se sube a 10: sigue siendo un menú usable en ambos
 * canales, pero deja de recortar el criterio de Claude sobre cuántas
 * alternativas ofrecer.
 */
export const MAX_OPTIONS = 10;

/** Telegram corta `callback_data` en 64 bytes; `q:<uuid36>:<idx>` cabe holgado. */
export const CALLBACK_PREFIX = 'q';

/**
 * Mensajes `out` permitidos por hora. Un Claude en bucle no puede inundar el
 * móvil del owner: al pasarse, el endpoint responde 429 y no manda nada.
 *
 * A diferencia de `MAX_OPTIONS`/el límite de caracteres del body, esto NO es
 * un artefacto de Telegram — protege al owner de un bug real (un loop que
 * manda mensajes sin parar) sin importar qué canal los muestre, así que se
 * mantiene igual aunque el dashboard no tenga la limitación técnica que sí
 * tiene el teclado inline.
 */
export const MAX_OUT_PER_HOUR = 30;

/**
 * Tope de caracteres por mensaje (tanto `out` de Claude como `in` del owner).
 * NO es el límite de 4096 de un mensaje de Telegram — `RelayBotService.deliver()`
 * ya trocea con `splitForTelegram` antes de entregar, así que un mensaje largo
 * de Claude llega igual, solo que en varios mensajes de Telegram. Este tope es
 * apenas una cota de sanidad para el tamaño de la fila en Postgres/el payload
 * HTTP, no una restricción real de lo que Claude puede decir de una vez.
 */
export const MAX_BODY_LENGTH = 50_000;

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
 * Fila del historial para el dashboard (`GET /api/bridge/messages`) — a
 * diferencia de `RelayInboxMessage`, incluye `direction` (el dashboard
 * muestra ambos sentidos) y `options` (para pintar los mismos botones que
 * ya ofrece Telegram).
 *
 * `bodyHtml`: el mismo `markdownToTelegramHtml(body)` que ya usa el bot de
 * Telegram (`src/telegram/telegram-format.ts`) — sin esto, el dashboard
 * mostraría `**negrita**`/`` `código` `` literales mientras que Telegram
 * los renderiza. Se calcula server-side (no en el navegador) a propósito:
 * es la única función ya auditada para tratar texto no confiable (un
 * mensaje de Claude puede citar contenido de un correo o una página con
 * una inyección de prompt) — escapa todo antes de emitir cualquier tag,
 * nunca genera `<a href>`, y su salida (`<b> <i> <s> <code> <pre>
 * <blockquote>`) son tags HTML reales, seguros para `dangerouslySetInnerHTML`
 * sin sanitizar de nuevo del lado del cliente.
 */
export interface RelayHistoryMessage {
  readonly id: string;
  readonly direction: 'in' | 'out';
  readonly body: string;
  readonly bodyHtml: string;
  readonly options?: readonly string[];
  readonly answerTo?: string;
  readonly createdAt: string;
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
