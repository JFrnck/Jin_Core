import type { ModelMessage } from '../model-provider/model-provider.types';
import type {
  AgentRunStatus,
  ReconciliationOutput,
  Ticket,
} from './orchestrator.types';

/**
 * Lógica pura del orquestador (Fase 5.4, ADR 0005) — testeable sin
 * DB/LLM, mismo criterio que `agent.logic.ts`/`budget.logic.ts`.
 */

/**
 * Tickets listos para correr: `status === 'pending'` y TODAS sus
 * dependencias ya están `done`. Un ticket cuya dependencia quedó
 * `blocked`/`failed` nunca se vuelve "ready" — se queda `pending` para
 * siempre en este run (ADR 0005: el modelo no reintenta automáticamente
 * un run bloqueado).
 */
export function computeReadyBatch(tickets: readonly Ticket[]): Ticket[] {
  const statusById = new Map(tickets.map((t) => [t.id, t.status]));
  return tickets.filter(
    (t) =>
      t.status === 'pending' &&
      t.dependsOn.every((depId) => statusById.get(depId) === 'done'),
  );
}

/** Agrupa en chunks de tamaño máximo `size` (>=1) preservando el orden. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) {
    throw new Error(`chunk: size debe ser >= 1, recibido ${size}`);
  }
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Estado final de un run, derivado del estado de sus tickets tras el
 * loop de batches + la reconciliación (ADR 0005). Prioridad: 'killed'
 * siempre gana (lo decide el caller al detectar KillSwitchActiveError,
 * no esta función). Acá: si queda algún ticket sin resolver
 * ('pending'/'in-progress'/'blocked') → 'blocked'; si algún ticket
 * 'failed' y ninguno pendiente → 'failed'; si todos 'done' → 'done'.
 */
export function computeRunStatus(
  tickets: readonly Ticket[],
  reconciliation: ReconciliationOutput | null,
): AgentRunStatus {
  const hasUnresolvedMaterialConflict =
    reconciliation?.conflicts.some((c) => c.riskLevel === 'material') ?? false;
  const hasUnfinished = tickets.some(
    (t) =>
      t.status === 'pending' ||
      t.status === 'in-progress' ||
      t.status === 'blocked',
  );
  if (hasUnfinished || hasUnresolvedMaterialConflict) {
    return 'blocked';
  }
  const hasFailed = tickets.some((t) => t.status === 'failed');
  if (hasFailed) {
    return 'failed';
  }
  return 'done';
}

/**
 * Contexto del board que ve un sub-agente antes de arrancar (ADR 0005
 * punto 4: visibilidad causal, no instantánea entre pares del mismo
 * lote) — inyectado como par sintético user/assistant al inicio de su
 * `history`, mismo mecanismo que Fase 5.3 usa para memoria recuperada.
 * `[]` si no hay siblings completados todavía (nada que mostrar).
 */
export function buildBoardContextMessages(
  completedSiblings: readonly Ticket[],
): ModelMessage[] {
  if (completedSiblings.length === 0) {
    return [];
  }
  const summary = completedSiblings
    .map(
      (t) =>
        `- ${t.description}\n  Resultado: ${t.result ?? '(sin resultado)'}`,
    )
    .join('\n');
  return [
    {
      role: 'user',
      content:
        'Estado actual del tablero — esto es lo que otros sub-agentes ya resolvieron en este mismo objetivo:\n\n' +
        summary,
    },
    {
      role: 'assistant',
      content:
        'Entendido, tengo en cuenta el estado del tablero para mi propia tarea.',
    },
  ];
}
