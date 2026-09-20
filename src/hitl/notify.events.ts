// Notificación POST-HOC de una acción `notify` (BLUEPRINT 9.1: "ejecuta y
// envía notificación post-hoc"). Hasta el ADR 0010 el nivel `notify` solo
// escribía una fila `notified` en el audit y NADIE avisaba al owner -- con los
// modos de autonomía (confirm -> notify) eso habría sido ejecutar acciones sin
// ninguna señal. `AgentService` emite este evento; Telegram lo escucha.
export const HITL_ACTION_NOTIFIED_EVENT = 'hitl.action.notified';

export interface HitlActionNotifiedEvent {
  readonly requestId: string;
  readonly toolName: string;
  readonly actor: string;
  /** `autonomy:<modo>` si un modo de autonomía la relajó; ausente si ya era `notify`. */
  readonly relaxedBy?: string;
}
