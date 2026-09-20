import type { AutonomyMode } from './autonomy.types';

// Cada cambio de modo se notifica al owner (Telegram escucha este evento).
export const AUTONOMY_MODE_CHANGED_EVENT = 'autonomy.mode.changed';

export type AutonomyChangeReason =
  | 'approved' // pasó el dual-confirm
  | 'downgrade' // el owner volvió a un modo más restrictivo
  | 'expired' // caducó y volvió a supervised
  | 'circuit-breaker'; // demasiadas acciones autoejecutadas

export interface AutonomyModeChangedEvent {
  readonly mode: AutonomyMode;
  readonly previousMode: AutonomyMode;
  readonly reason: AutonomyChangeReason;
  readonly expiresAt: string | null;
  readonly setBy: string;
}
