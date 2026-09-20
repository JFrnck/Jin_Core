import { z } from 'zod';

/**
 * Modos de autonomía del HITL (ADR 0010). Zod es la fuente de verdad; el
 * tipo se infiere (AGENTS.md 3.4, nunca un TS `enum`).
 *
 * - `supervised`: el comportamiento estático de siempre (default seguro).
 * - `semi-auto`: `confirm` pasa a `notify`, EXCEPTO las tools marcadas
 *   `guardedInSemiAuto` en el registry (git/merge, correos, borrar eventos
 *   futuros), que siguen pidiendo aprobación.
 * - `auto`: todo `confirm` pasa a `notify`.
 * En NINGÚN modo se relaja un `dual-confirm` ni una tool `humanDecision`.
 */
export const AUTONOMY_MODES = ['supervised', 'semi-auto', 'auto'] as const;
export const AutonomyModeSchema = z.enum(AUTONOMY_MODES);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;

/** Más alto = menos restrictivo. `AUTONOMY_MODES` ya está en orden creciente. */
export function autonomyOrdinal(mode: AutonomyMode): number {
  return AUTONOMY_MODES.indexOf(mode);
}

/**
 * Pasar a `target` desde `current` ¿necesita `dual-confirm`? Sí cuando NO
 * vuelve a algo más restrictivo -- incluida la RENOVACIÓN del mismo modo
 * relajado (extiende el tiempo sin protección). Volver a `supervised`, o a un
 * modo más restrictivo, es inmediato (regla de oro #4: bajar la protección
 * exige dual-confirm humano; subirla, no).
 */
export function requiresDualConfirm(
  current: AutonomyMode,
  target: AutonomyMode,
): boolean {
  return (
    target !== 'supervised' &&
    autonomyOrdinal(target) >= autonomyOrdinal(current)
  );
}

export interface AutonomyState {
  /** Modo EFECTIVO ahora (ya descontada la caducidad). */
  readonly mode: AutonomyMode;
  readonly expiresAt: Date | null;
  readonly setBy: string;
  readonly changedAt: Date;
}
