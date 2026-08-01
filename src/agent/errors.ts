import { JinError } from '../common/errors/jin-error';

export class AgentPlanStepOutOfBoundsError extends JinError {
  constructor(stepIndex: number, totalSteps: number) {
    super(
      `updatePlanStep: índice ${stepIndex} fuera de rango (el plan tiene ${totalSteps} pasos)`,
      { code: 'AGENT_PLAN_STEP_OUT_OF_BOUNDS', httpStatus: 400 },
    );
  }
}

/**
 * Fase 5.4 (orquestación multi-agente, ADR 0005). El LLM de descomposición
 * (TaskProfile `reasoning_heavy`) debe responder JSON estricto — falla
 * ruidoso ante formato inválido, mismo patrón que `ConsolidationParseError`
 * en `src/memory/errors.ts`.
 */
export class TicketDecompositionParseError extends JinError {
  constructor(rawContent: string) {
    super(
      `Respuesta de descomposición de tickets no es JSON válido con la forma esperada: ${rawContent.slice(0, 200)}`,
      { code: 'AGENT_TICKET_DECOMPOSITION_PARSE_ERROR', httpStatus: 502 },
    );
  }
}

/** Ídem para la pasada de reconciliación final (Fase 5.4, ADR 0005). */
export class ReconciliationParseError extends JinError {
  constructor(rawContent: string) {
    super(
      `Respuesta de reconciliación no es JSON válido con la forma esperada: ${rawContent.slice(0, 200)}`,
      { code: 'AGENT_RECONCILIATION_PARSE_ERROR', httpStatus: 502 },
    );
  }
}

/**
 * Fase 5.4 (orquestación multi-agente, ADR 0005 punto 9). `mergeAgentBranch`
 * está declarada en `registry.ts` (guardrail exigido por PROMPTS.md §5.4)
 * pero sin implementación real: hoy ningún tool le da a un sub-agente la
 * capacidad de producir una branch de código real — mismo patrón que
 * `CalendarNotImplementedError` (Fase 3.1). Falla ruidoso, no en silencio.
 */
export class AgentBranchMergeNotImplementedError extends JinError {
  constructor() {
    super(
      'mergeAgentBranch todavía no está implementada — no existe hoy ninguna ' +
        'tool que le dé a un sub-agente la capacidad de producir una branch ' +
        'de código real (ADR 0005 punto 9).',
      { code: 'AGENT_BRANCH_MERGE_NOT_IMPLEMENTED', httpStatus: 501 },
    );
  }
}
