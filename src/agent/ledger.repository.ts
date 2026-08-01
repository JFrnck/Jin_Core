import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
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
}
