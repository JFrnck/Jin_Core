import type { HitlDecision } from '../hitl/types';
import type { ToolDefinition } from '../tools/registry';
import type { AutonomyMode } from './autonomy.types';

export interface RelaxResult {
  readonly decision: HitlDecision;
  /** `autonomy:<modo>` cuando el nivel se relajó; ausente si quedó igual. */
  readonly relaxedBy?: string;
}

type RelaxableTool = Pick<
  ToolDefinition,
  'guardedInSemiAuto' | 'humanDecision'
>;

/**
 * Regla de relajación de un modo de autonomía (ADR 0010). FUNCIÓN PURA:
 * es donde vive toda la política, y por eso se prueba con la matriz
 * completa (tool × modo × nivel, BLUEPRINT 9.3).
 *
 * Solo `confirm` se relaja, y solo hacia `notify` (se ejecuta y se avisa).
 * **Nunca** se relaja:
 * - `dual-confirm` (piso de seguridad, reglas de oro #4 y #7);
 * - `auto` / `notify` (ya son laxos: no hay nada que relajar);
 * - una tool `humanDecision` (p. ej. `resolveAgentConflict`: es una decisión,
 *   no una acción -- automatizarla la vaciaría de sentido);
 * - en `semi-auto`, una tool `guardedInSemiAuto`.
 */
export function relaxDecision(
  decision: HitlDecision,
  mode: AutonomyMode,
  tool: RelaxableTool | undefined,
): RelaxResult {
  if (mode === 'supervised') return { decision };
  if (decision.level !== 'confirm') return { decision };
  if (tool?.humanDecision === true) return { decision };
  if (mode === 'semi-auto' && tool?.guardedInSemiAuto === true) {
    return { decision };
  }

  return {
    decision: {
      ...decision,
      level: 'notify',
      approvalsRequired: 0,
      notifyAfterExecution: true,
      relaxedBy: `autonomy:${mode}`,
    },
    relaxedBy: `autonomy:${mode}`,
  };
}

/** Acota `hours` a [1, max]; sin valor usa el default del modo. */
export function clampHours(
  requested: number | undefined,
  defaults: { readonly defaultHours: number; readonly maxHours: number },
): number {
  const hours = requested ?? defaults.defaultHours;
  return Math.min(Math.max(Math.trunc(hours), 1), defaults.maxHours);
}

export type ModeCommand =
  | { readonly kind: 'status' }
  | {
      readonly kind: 'change';
      readonly mode: AutonomyMode;
      readonly hours?: number;
    }
  | { readonly kind: 'invalid' };

const MODE_ALIASES: Readonly<Record<string, AutonomyMode>> = {
  safe: 'supervised',
  seguro: 'supervised',
  supervised: 'supervised',
  supervisado: 'supervised',
  hitl: 'supervised',
  semi: 'semi-auto',
  semiauto: 'semi-auto',
  'semi-auto': 'semi-auto',
  semiautomatico: 'semi-auto',
  semiautomático: 'semi-auto',
  auto: 'auto',
  automatico: 'auto',
  automático: 'auto',
};

/**
 * Parsea los argumentos del comando de Telegram `/mode`:
 *   `/mode`            -> estado
 *   `/mode safe`       -> supervised
 *   `/mode semi [h]`   -> semi-auto durante h horas (default de la config)
 *   `/mode auto [h]`   -> auto durante h horas
 * Entrada inválida -> `invalid`, nunca un cambio adivinado.
 */
export function parseModeCommand(args: string | undefined): ModeCommand {
  const parts = (args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: 'status' };
  if (parts.length > 2) return { kind: 'invalid' };

  const mode = MODE_ALIASES[parts[0] ?? ''];
  if (mode === undefined) return { kind: 'invalid' };

  if (parts.length === 1) return { kind: 'change', mode };
  const hours = Number(parts[1]);
  if (!Number.isInteger(hours) || hours <= 0) return { kind: 'invalid' };
  return { kind: 'change', mode, hours };
}
