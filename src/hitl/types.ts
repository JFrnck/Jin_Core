import { z } from 'zod';

/**
 * Los 4 niveles de HITL (BLUEPRINT 9.1, ADR 0001). Zod es la fuente de
 * verdad; el tipo se infiere (AGENTS.md 3.4) — nunca un TS `enum`
 * (AGENTS.md 3.2 prohíbe enums, prefiere uniones de literales).
 */
export const HITL_LEVELS = [
  'auto',
  'notify',
  'confirm',
  'dual-confirm',
] as const;
export const HitlLevelSchema = z.enum(HITL_LEVELS);
export type HitlLevel = z.infer<typeof HitlLevelSchema>;

/**
 * Posición de un nivel en la escala de restricción (Fase 9.5,
 * `feature-flags`) — `HITL_LEVELS` ya está declarado en orden creciente,
 * esto solo le da nombre al índice para no repetir el array en cada
 * comparación "¿este override sube o baja el nivel?".
 */
export function hitlLevelOrdinal(level: HitlLevel): number {
  return HITL_LEVELS.indexOf(level);
}

/** Cuántas aprobaciones humanas requiere cada nivel — derivado, no declarado dos veces. */
export function approvalsRequiredFor(level: HitlLevel): 0 | 1 | 2 {
  switch (level) {
    case 'auto':
    case 'notify':
      return 0;
    case 'confirm':
      return 1;
    case 'dual-confirm':
      return 2;
  }
}

export interface HitlDecision {
  /** uuid — correlaciona esta decisión con sus filas en audit_log/pending_approvals (ADR 0002). */
  readonly requestId: string;
  readonly toolName: string;
  readonly level: HitlLevel;
  readonly approvalsRequired: 0 | 1 | 2;
  /** Solo `true` para 'notify': se ejecuta y se notifica DESPUÉS, sin esperar aprobación. */
  readonly notifyAfterExecution: boolean;
  /**
   * Presente solo si un modo de autonomía relajó el nivel (`autonomy:<modo>`,
   * ADR 0010). Va al audit y a la notificación post-hoc: el owner siempre
   * puede ver QUÉ se autoejecutó y POR QUÉ no pidió aprobación.
   */
  readonly relaxedBy?: string;
}
