import { createHash } from 'node:crypto';
import { AgentPlanStepOutOfBoundsError } from './errors';
import type { AgentPlan, AgentStepStatus } from './agent.types';

/**
 * Lógica pura del agent loop (AGENTS.md 6.4: extraída de `agent.service.ts`
 * para testear sin mocks). Todo lo que toca red/DB/LLM vive en el service.
 */

export function declarePlan(steps: readonly string[]): AgentPlan {
  return {
    steps: steps.map((description) => ({ description, status: 'pending' })),
  };
}

export function updatePlanStep(
  plan: AgentPlan,
  stepIndex: number,
  status: AgentStepStatus,
  note?: string,
): AgentPlan {
  if (stepIndex < 0 || stepIndex >= plan.steps.length) {
    throw new AgentPlanStepOutOfBoundsError(stepIndex, plan.steps.length);
  }

  return {
    steps: plan.steps.map((step, index) =>
      index === stepIndex
        ? { ...step, status, ...(note !== undefined ? { note } : {}) }
        : step,
    ),
  };
}

/**
 * Clave de deduplicación para el cap de reintentos consecutivos
 * (Fase 5.1, self-correction): misma tool + mismos args exactos.
 */
export function buildToolCallKey(toolName: string, input: unknown): string {
  return `${toolName}:${JSON.stringify(input ?? null)}`;
}

/** Mismo patrón que `canvas-tools.service.ts`/`google-*-tools.service.ts`: hash de auditoría de los inputs. */
export function computeInputsHash(data: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(data ?? {}))
    .digest('hex');
}

/** El resultado de un tool es `unknown` — se serializa antes de sanitizar/reinyectar al contexto. */
export function stringifyToolResult(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result);
}
