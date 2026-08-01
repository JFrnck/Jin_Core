/**
 * Tipos del ledger multi-agente (Fase 5.4, ADR 0005). Los estados de
 * `AgentTicketStatus`/`AgentRunStatus` son la fuente de verdad — los
 * valores `text` de `agent_tickets.status`/`agent_orchestration_runs.status`
 * en `src/db/schema.ts` deben coincidir exactamente.
 */

export const AGENT_TICKET_STATUSES = [
  'pending',
  'in-progress',
  'done',
  'failed',
  'blocked',
] as const;
export type AgentTicketStatus = (typeof AGENT_TICKET_STATUSES)[number];

export const AGENT_RUN_STATUSES = [
  'running',
  'blocked',
  'done',
  'failed',
  'killed',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const AGENT_COMMENT_AUTHOR_TYPES = [
  'orchestrator',
  'sub_agent',
  'owner',
] as const;
export type AgentCommentAuthorType =
  (typeof AGENT_COMMENT_AUTHOR_TYPES)[number];

export const AGENT_COMMENT_KINDS = [
  'note',
  'result',
  'conflict',
  'resolution',
] as const;
export type AgentCommentKind = (typeof AGENT_COMMENT_KINDS)[number];

/** Un ticket recién decidido por la descomposición, antes de persistir (sin id real todavía — `dependsOn` referencia por índice). */
export interface DecomposedTicketDraft {
  readonly description: string;
  readonly allowedTools: readonly string[];
  /** Índices 0-based, dentro de la misma lista de drafts, de los tickets de los que depende. */
  readonly dependsOnIndexes: readonly number[];
}

export interface Ticket {
  readonly id: string;
  readonly runId: string;
  readonly description: string;
  readonly status: AgentTicketStatus;
  readonly assignedSubAgentId: string | null;
  readonly allowedTools: readonly string[];
  readonly dependsOn: readonly string[];
  readonly result: string | null;
}

export interface TicketComment {
  readonly id: string;
  readonly ticketId: string;
  readonly authorType: AgentCommentAuthorType;
  readonly authorId: string | null;
  readonly kind: AgentCommentKind;
  readonly body: string;
}

export interface ReconciliationConflict {
  readonly ticketIds: readonly string[];
  readonly summary: string;
  readonly riskLevel: 'low' | 'material';
  readonly proposedResolution: string;
}

export interface ReconciliationOutput {
  readonly finalResponse: string;
  readonly conflicts: readonly ReconciliationConflict[];
}

export interface OrchestrationResult {
  readonly runId: string;
  readonly status: AgentRunStatus;
  readonly finalResponse: string | null;
  readonly pendingApprovals: readonly { requestId: string; ticketId: string }[];
}
