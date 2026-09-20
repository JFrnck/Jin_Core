import type { MorningAlertEvent } from './morning-alert.events';

/** Límite de un mensaje de texto de Telegram. */
export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

const TRUNCATION_NOTICE = '\n\n… (resumen truncado)';

/**
 * Texto de la alerta de las 06:00. El resumen sale de contenido NO CONFIABLE
 * (Canvas → LLM): quien lo envíe debe hacerlo como texto plano, SIN
 * `parse_mode` (no interpretar Markdown/HTML controlado por un tercero).
 * Se trunca al límite de Telegram para que el envío nunca falle por longitud.
 */
export function formatMorningAlert(event: MorningAlertEvent): string {
  let text: string;
  switch (event.kind) {
    case 'summary':
      text = `☀️ Buenos días — prioridades de hoy (análisis de las 00:00)\n\n${event.summaryMarkdown}`;
      break;
    case 'failed':
      text =
        '⚠️ El análisis académico de las 00:00 FALLÓ, así que no hay resumen fiable de prioridades para hoy.\n' +
        `Motivo: ${event.error}\n` +
        'Revisá Canvas a mano y avisame si el fallo se repite.';
      break;
    case 'missing':
      text =
        '⚠️ El análisis académico de las 00:00 NO se ejecutó (no hay ninguna corrida registrada en las últimas 12 h), ' +
        'así que no hay resumen de prioridades para hoy. Revisá Canvas a mano.';
      break;
  }

  if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) return text;
  return (
    text.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - TRUNCATION_NOTICE.length) +
    TRUNCATION_NOTICE
  );
}
