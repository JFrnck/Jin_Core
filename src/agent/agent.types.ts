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
}

export interface AgentTurnResult {
  readonly finalResponse: string;
  readonly plan: AgentPlan;
  /** Tools confirm/dual-confirm que quedaron diferidas esperando aprobación en este turno. */
  readonly pendingApprovals: readonly AgentPendingApproval[];
  readonly iterationsUsed: number;
}
