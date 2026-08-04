import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { asc, desc, eq, lt } from 'drizzle-orm';
import { DB_CONNECTION, type Db } from '../db/db.module';
import {
  agentOrchestrationRuns,
  agentTicketComments,
  agentTickets,
} from '../db/schema';
import type {
  AgentCommentAuthorType,
  AgentCommentKind,
  AgentRunStatus,
  AgentTicketStatus,
  DecomposedTicketDraft,
  Ticket,
  TicketComment,
} from './orchestrator.types';

export interface RunSummary {
  readonly id: string;
  readonly objective: string;
  readonly status: AgentRunStatus;
  readonly parentSessionId: string;
  readonly finalResponse: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface ListRunsInput {
  readonly limit: number;
  readonly cursor?: string;
}

export interface ListRunsResult {
  readonly items: readonly RunSummary[];
  readonly nextCursor: string | null;
}

/**
 * CRUD Drizzle del task ledger (Fase 5.4, ADR 0005) — rol equivalente a
 * `dual-confirm.service.ts` pero para runs/tickets/comentarios en vez de
 * pending approvals. Persistido en Postgres: un run puede quedar días
 * bloqueado esperando HITL y debe sobrevivir restarts (mismo criterio
 * que `pending_approvals`).
 */
@Injectable()
export class LedgerRepository {
  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  async createRun(input: {
    objective: string;
    parentSessionId: string;
  }): Promise<string> {
    const id = randomUUID();
    await this.db.insert(agentOrchestrationRuns).values({
      id,
      objective: input.objective,
      parentSessionId: input.parentSessionId,
      status: 'running',
    });
    return id;
  }

  /**
   * Persiste los tickets decididos por la descomposición, resolviendo
   * `dependsOnIndexes` (posiciones dentro de `drafts`) a los `id` uuid
   * reales recién generados — en una sola pasada, todos los ids ya se
   * conocen de antemano.
   */
  async createTickets(
    runId: string,
    drafts: readonly DecomposedTicketDraft[],
  ): Promise<Ticket[]> {
    const ids = drafts.map(() => randomUUID());
    const rows = drafts.map((draft, index) => ({
      id: ids[index]!,
      runId,
      description: draft.description,
      status: 'pending' as const,
      allowedTools: [...draft.allowedTools],
      dependsOn: draft.dependsOnIndexes.map((depIndex) => ids[depIndex]!),
    }));

    if (rows.length > 0) {
      await this.db.insert(agentTickets).values(rows);
    }

    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      description: row.description,
      status: row.status,
      assignedSubAgentId: null,
      allowedTools: row.allowedTools,
      dependsOn: row.dependsOn,
      result: null,
    }));
  }

  async getTickets(runId: string): Promise<Ticket[]> {
    const rows = await this.db
      .select()
      .from(agentTickets)
      .where(eq(agentTickets.runId, runId))
      .orderBy(asc(agentTickets.createdAt));
    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      description: row.description,
      status: row.status as AgentTicketStatus,
      assignedSubAgentId: row.assignedSubAgentId,
      allowedTools: row.allowedTools,
      dependsOn: row.dependsOn,
      result: row.result,
    }));
  }

  async updateTicketStatus(
    ticketId: string,
    status: AgentTicketStatus,
    result?: string,
  ): Promise<void> {
    await this.db
      .update(agentTickets)
      .set({
        status,
        ...(result !== undefined ? { result } : {}),
        updatedAt: new Date(),
      })
      .where(eq(agentTickets.id, ticketId));
  }

  async assignSubAgent(ticketId: string, subAgentId: string): Promise<void> {
    await this.db
      .update(agentTickets)
      .set({ assignedSubAgentId: subAgentId, updatedAt: new Date() })
      .where(eq(agentTickets.id, ticketId));
  }

  async addComment(input: {
    ticketId: string;
    authorType: AgentCommentAuthorType;
    authorId?: string;
    kind: AgentCommentKind;
    body: string;
  }): Promise<void> {
    await this.db.insert(agentTicketComments).values({
      ticketId: input.ticketId,
      authorType: input.authorType,
      authorId: input.authorId ?? null,
      kind: input.kind,
      body: input.body,
    });
  }

  async getComments(ticketId: string): Promise<TicketComment[]> {
    const rows = await this.db
      .select()
      .from(agentTicketComments)
      .where(eq(agentTicketComments.ticketId, ticketId))
      .orderBy(asc(agentTicketComments.createdAt));
    return rows.map((row) => ({
      id: row.id.toString(),
      ticketId: row.ticketId,
      authorType: row.authorType as AgentCommentAuthorType,
      authorId: row.authorId,
      kind: row.kind as AgentCommentKind,
      body: row.body,
    }));
  }

  /**
   * Tickets ya `done` de este run, excluyendo uno (el que está por
   * arrancar) — la base del "board causal" que ve un sub-agente antes de
   * correr (ADR 0005 punto 4): solo lo resuelto en lotes anteriores,
   * nunca lo que corre en paralelo en el lote actual.
   */
  async getCompletedSiblings(
    runId: string,
    excludeTicketId: string,
  ): Promise<Ticket[]> {
    const tickets = await this.getTickets(runId);
    return tickets.filter(
      (t) => t.id !== excludeTicketId && t.status === 'done',
    );
  }

  async completeRun(
    runId: string,
    status: AgentRunStatus,
    finalResponse: string | null,
  ): Promise<void> {
    await this.db
      .update(agentOrchestrationRuns)
      .set({ status, finalResponse, completedAt: new Date() })
      .where(eq(agentOrchestrationRuns.id, runId));
  }

  private toRunSummary(
    row: typeof agentOrchestrationRuns.$inferSelect,
  ): RunSummary {
    return {
      id: row.id,
      objective: row.objective,
      status: row.status as AgentRunStatus,
      parentSessionId: row.parentSessionId,
      finalResponse: row.finalResponse,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    };
  }

  /**
   * Lectura paginada de runs para el board de orquestación (Fase 6.2/6.3,
   * panel "Board de orquestación"). Cursor por `createdAt`, no por `id`
   * (uuid, sin orden natural) — mismo criterio de "limit+1" que
   * `AuditService.listRecent()`.
   */
  async listRuns(input: ListRunsInput): Promise<ListRunsResult> {
    const rows = await this.db
      .select()
      .from(agentOrchestrationRuns)
      .where(
        input.cursor
          ? lt(agentOrchestrationRuns.createdAt, new Date(input.cursor))
          : undefined,
      )
      .orderBy(desc(agentOrchestrationRuns.createdAt))
      .limit(input.limit + 1);

    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    const nextCursor = hasMore
      ? (items[items.length - 1]?.createdAt.toISOString() ?? null)
      : null;

    return { items: items.map((row) => this.toRunSummary(row)), nextCursor };
  }

  /** `null` si no existe — el controller decide el 404 (`RunNotFoundError`). */
  async getRun(runId: string): Promise<RunSummary | null> {
    const rows = await this.db
      .select()
      .from(agentOrchestrationRuns)
      .where(eq(agentOrchestrationRuns.id, runId));
    const row = rows[0];
    return row ? this.toRunSummary(row) : null;
  }
}
