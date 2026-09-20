// Fase 9.4: alerta matutina (06:00). Canvas no importa Telegram: emite este
// evento y el bot lo escucha (mismo patrón que autonomy.mode.changed).
export const MORNING_ALERT_EVENT = 'shadowing.morning.alert';

export type MorningAlertEvent =
  | {
      readonly kind: 'summary';
      readonly ranAt: string;
      readonly summaryMarkdown: string;
    }
  // La corrida de las 00:00 falló: se dice explícitamente (nunca un resumen vacío).
  | { readonly kind: 'failed'; readonly ranAt: string; readonly error: string }
  // No hay ninguna corrida reciente (pod caído a medianoche, cron no disparó).
  | { readonly kind: 'missing' };
