import { z } from 'zod';
import type { ModelMessage } from '../model-provider/model-provider.types';

/**
 * Plan-and-solve (Fase 5.1, requisito explícito del owner): el modelo
 * declara su plan vía la meta-tool `declarePlan` y lo revisa vía
 * `updatePlanStep` — la autocorrección queda visible como una revisión
 * de estado, no como texto libre a parsear. Transient: vive en memoria
 * durante el turno, se devuelve en la respuesta. La persistencia en
 * Postgres del ledger multi-agente es de la Fase 5.4, no se anticipa acá.
 */
export const AGENT_STEP_STATUSES = [
  'pending',
  'in-progress',
  'done',
  'failed',
] as const;
export const AgentStepStatusSchema = z.enum(AGENT_STEP_STATUSES);
export type AgentStepStatus = z.infer<typeof AgentStepStatusSchema>;

export interface AgentStep {
  readonly description: string;
  readonly status: AgentStepStatus;
  readonly note?: string;
}

export interface AgentPlan {
  readonly steps: readonly AgentStep[];
}

export interface AgentPendingApproval {
  readonly requestId: string;
  readonly toolName: string;
}

export interface AgentTurnInput {
  readonly sessionId: string;
  readonly objective: string;
  /** Historial previo del turno/conversación, si lo hay (Fase 5.3 lo arma desde Telegram). */
  readonly history?: readonly ModelMessage[];
  /**
   * Subset de nombres de tool a declarar (Fase 5.4, ADR 0005): el
   * orquestador lo usa para que un sub-agente solo vea las tools de su
   * ticket. Si se omite, se declaran TODAS las de `listRegisteredTools()`
   * — comportamiento idéntico al de antes de esta fase (retrocompatible).
   */
  readonly allowedTools?: readonly string[];
  /**
   * Atribución en `audit_log.actor`/`pendingApprovals.planSummary`
   * (Fase 5.4, ADR 0005). Default `'agent'` si se omite — mismo valor
   * hardcodeado que usaba el loop antes de esta fase.
   */
  readonly actorLabel?: string;
}

export interface AgentTurnResult {
  readonly finalResponse: string;
  readonly plan: AgentPlan;
  /** Tools confirm/dual-confirm que quedaron diferidas esperando aprobación en este turno. */
  readonly pendingApprovals: readonly AgentPendingApproval[];
  readonly iterationsUsed: number;
  /**
   * Presente SOLO cuando el turno comprimió el historial (poda +
   * compresión, docs/RECOMENDACIONES.md #2). `/api/chat` es stateless
   * (Fase 6.1) — el caller es dueño de su propio historial, así que este
   * campo es la forma en que el servidor le devuelve el historial ya
   * comprimido para que lo ADOPTE (reemplace, no concatene) como base
   * del próximo turno. Ausente, nunca `[]`, cuando no hizo falta
   * comprimir — así el caller distingue "sin cambios" de "se vació".
   */
  readonly compactedHistory?: readonly ModelMessage[];
}
