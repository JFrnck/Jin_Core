// Turno de chat terminado con la app ya desconectada: lo escuchan las
// notificaciones push (ADR 0014).
export const CHAT_TURN_FINISHED_EVENT = 'chat.turn.finished';

export interface ChatTurnFinishedEvent {
  readonly sessionId: string;
  readonly objective: string;
  readonly ok: boolean;
}
