import { Inject, Injectable, Logger } from '@nestjs/common';
import { KillSwitchActiveError } from '../budget/errors';
import { KillSwitchService } from '../budget/kill-switch.service';
import { classifyToolCall } from '../hitl/classifier';
import { DualConfirmService } from '../hitl/dual-confirm.service';
import { listRegisteredTools } from '../tools/registry';
import type { AgentConfig } from './agent-config.schema';
import { AgentService } from './agent.service';
import { AGENT_CONFIG } from './agent.tokens';
import { computeInputsHash } from './agent.logic';
import { LedgerRepository } from './ledger.repository';
import {
  buildBoardContextMessages,
  chunk,
  computeReadyBatch,
  computeRunStatus,
} from './orchestrator.logic';
import type {
  OrchestrationResult,
  ReconciliationOutput,
  Ticket,
  TicketComment,
} from './orchestrator.types';
import { ReconciliationService } from './reconciliation.service';
import { TicketDecompositionService } from './ticket-decomposition.service';

const RESOLVE_CONFLICT_TOOL_NAME = 'resolveAgentConflict';

/**
 * Orquestador multi-agente (Fase 5.4, ADR 0005). Descompone un objetivo
 * en tickets del task ledger, los delega a instancias adicionales de
 * `AgentService` corriendo en lotes por dependencias, y reconcilia los
 * resultados en una única respuesta al final — escalando al owner (vía
 * el HITL existente) cualquier conflicto material entre sub-agentes.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly ledger: LedgerRepository,
    private readonly ticketDecomposition: TicketDecompositionService,
    private readonly reconciliation: ReconciliationService,
    private readonly agentService: AgentService,
    private readonly dualConfirmService: DualConfirmService,
    private readonly killSwitchService: KillSwitchService,
    @Inject(AGENT_CONFIG) private readonly config: AgentConfig,
  ) {}

  async runObjective(input: {
    sessionId: string;
    objective: string;
  }): Promise<OrchestrationResult> {
    const runId = await this.ledger.createRun({
      objective: input.objective,
      parentSessionId: input.sessionId,
    });

    const drafts = await this.ticketDecomposition.decompose(
      runId,
      input.objective,
      listRegisteredTools(),
    );
    let tickets = await this.ledger.createTickets(runId, drafts);

    const killed = await this.runBatchesUntilDone(runId, tickets);
    if (killed) {
      await this.ledger.completeRun(runId, 'killed', null);
      return {
        runId,
        status: 'killed',
        finalResponse: null,
        pendingApprovals: [],
      };
    }

    tickets = await this.ledger.getTickets(runId);
    const commentsByTicket = await this.loadCommentsByTicket(tickets);
    const reconciliationResult = await this.reconciliation.reconcile(
      runId,
      tickets,
      commentsByTicket,
    );

    const pendingApprovals = await this.applyReconciliation(
      runId,
      reconciliationResult,
    );

    tickets = await this.ledger.getTickets(runId);
    const finalStatus = computeRunStatus(tickets, reconciliationResult);
    await this.ledger.completeRun(
      runId,
      finalStatus,
      reconciliationResult.finalResponse,
    );

    return {
      runId,
      status: finalStatus,
      finalResponse: reconciliationResult.finalResponse,
      pendingApprovals,
    };
  }

  /**
   * Corre lotes de tickets listos hasta que no queda ninguno más por
   * arrancar (o el kill switch se activa). Devuelve `true` si el run se
   * cortó por kill switch — el caller marca el run entero 'killed' sin
   * seguir a la reconciliación (ADR 0005 punto 7).
   */
  private async runBatchesUntilDone(
    runId: string,
    initialTickets: readonly Ticket[],
  ): Promise<boolean> {
    let tickets = initialTickets;

    for (;;) {
      if (await this.killSwitchService.isActive()) {
        return true;
      }

      const ready = computeReadyBatch(tickets);
      if (ready.length === 0) {
        return false;
      }

      for (const batch of chunk(ready, this.config.maxConcurrentSubAgents)) {
        try {
          await Promise.all(
            batch.map((ticket) => this.runSubAgentForTicket(runId, ticket)),
          );
        } catch (err: unknown) {
          if (err instanceof KillSwitchActiveError) {
            return true;
          }
          throw err;
        }
      }

      tickets = await this.ledger.getTickets(runId);
    }
  }

  /**
   * Corre un sub-agente para un ticket: instancia adicional de
   * `AgentService.runTurn()` (ADR 0005 punto 1), nunca una clase nueva.
   * Cualquier error que NO sea `KillSwitchActiveError` se absorbe acá
   * (el ticket queda 'failed', no tira abajo el batch entero) —
   * `KillSwitchActiveError` se relanza a propósito para cortar todo el
   * run desde `runBatchesUntilDone`.
   */
  private async runSubAgentForTicket(
    runId: string,
    ticket: Ticket,
  ): Promise<void> {
    await this.ledger.updateTicketStatus(ticket.id, 'in-progress');
    await this.ledger.assignSubAgent(ticket.id, ticket.id);

    const siblings = await this.ledger.getCompletedSiblings(runId, ticket.id);
    const history = buildBoardContextMessages(siblings);

    try {
      const result = await this.agentService.runTurn({
        sessionId: `${runId}:${ticket.id}`,
        objective: ticket.description,
        history,
        allowedTools: ticket.allowedTools,
        actorLabel: `agent:${ticket.id}`,
      });

      await this.ledger.addComment({
        ticketId: ticket.id,
        authorType: 'sub_agent',
        authorId: ticket.id,
        kind: 'result',
        body: result.finalResponse,
      });

      await this.ledger.updateTicketStatus(
        ticket.id,
        result.pendingApprovals.length > 0 ? 'blocked' : 'done',
        result.finalResponse,
      );
    } catch (err: unknown) {
      if (err instanceof KillSwitchActiveError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Ticket ${ticket.id} falló: ${msg}`);
      await this.ledger.updateTicketStatus(ticket.id, 'failed');
      await this.ledger.addComment({
        ticketId: ticket.id,
        authorType: 'orchestrator',
        kind: 'note',
        body: `Sub-agente falló: ${msg}`,
      });
    }
  }

  private async loadCommentsByTicket(
    tickets: readonly Ticket[],
  ): Promise<Map<string, readonly TicketComment[]>> {
    const entries = await Promise.all(
      tickets.map(
        async (t) => [t.id, await this.ledger.getComments(t.id)] as const,
      ),
    );
    return new Map(entries);
  }

  /**
   * Aplica la escalera de decisión de ADR 0005 punto 5: conflictos 'low'
   * se resuelven en modo-auto (comentario de resolución, sin bloquear
   * nada); conflictos 'material' escalan vía la tool sintética
   * `resolveAgentConflict` — reusa `DualConfirmService`/Telegram tal
   * cual, sin canal de escalamiento nuevo.
   */
  private async applyReconciliation(
    runId: string,
    result: ReconciliationOutput,
  ): Promise<{ requestId: string; ticketId: string }[]> {
    const pendingApprovals: { requestId: string; ticketId: string }[] = [];

    for (const conflict of result.conflicts) {
      if (conflict.riskLevel === 'low') {
        for (const ticketId of conflict.ticketIds) {
          await this.ledger.addComment({
            ticketId,
            authorType: 'orchestrator',
            kind: 'resolution',
            body: `${conflict.summary} — resuelto en modo-auto: ${conflict.proposedResolution}`,
          });
        }
        continue;
      }

      const primaryTicketId = conflict.ticketIds[0];
      if (!primaryTicketId) {
        continue;
      }

      const payload = {
        ticketId: primaryTicketId,
        conflictSummary: conflict.summary,
        proposedResolution: conflict.proposedResolution,
        runId,
      };
      const decision = classifyToolCall(RESOLVE_CONFLICT_TOOL_NAME, payload);
      await this.dualConfirmService.createPendingApproval({
        requestId: decision.requestId,
        toolName: RESOLVE_CONFLICT_TOOL_NAME,
        level: decision.level as 'confirm' | 'dual-confirm',
        inputsHash: computeInputsHash(payload),
        planSummary: `Conflicto material en run ${runId} (tickets ${conflict.ticketIds.join(', ')}): ${conflict.summary}`,
        payload,
      });
      pendingApprovals.push({
        requestId: decision.requestId,
        ticketId: primaryTicketId,
      });

      for (const ticketId of conflict.ticketIds) {
        await this.ledger.addComment({
          ticketId,
          authorType: 'orchestrator',
          kind: 'conflict',
          body: conflict.summary,
        });
      }
    }

    return pendingApprovals;
  }
}
