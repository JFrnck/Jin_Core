import { JinError } from '../common/errors/jin-error';
import { MAX_OUT_PER_HOUR } from './relay.types';

/**
 * Tope de mensajes salientes por hora (ADR 0012). Existe para que una sesión
 * de Claude en bucle no inunde el móvil del owner: al pasarse, no se manda
 * nada y el CLI recibe un 429 claro.
 */
export class RelayQuotaExceededError extends JinError {
  constructor() {
    super(
      `El puente ya mandó ${MAX_OUT_PER_HOUR} mensajes en la última hora. Se corta para no inundar al owner.`,
      { code: 'RELAY_QUOTA_EXCEEDED', httpStatus: 429 },
    );
  }
}

/**
 * El puente no está configurado (faltan `TELEGRAM_RELAY_BOT_TOKEN` y/o
 * `RELAY_TOKEN`). Es 503 y no 401 a propósito: distingue "no lo montaste
 * todavía" de "tu token está mal", que son dos problemas muy distintos para
 * quien está depurando.
 */
export class RelayDisabledError extends JinError {
  constructor() {
    super(
      'El puente Claude↔owner no está configurado en esta instancia (faltan TELEGRAM_RELAY_BOT_TOKEN y/o RELAY_TOKEN).',
      { code: 'RELAY_DISABLED', httpStatus: 503 },
    );
  }
}
