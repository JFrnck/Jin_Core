import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BudgetModule } from '../budget/budget.module';
import { HitlModule } from '../hitl/hitl.module';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { AgentModule } from './agent.module';
import { AgentBranchMergeNotImplementedError } from './errors';
import { LedgerRepository } from './ledger.repository';
import { OrchestratorService } from './orchestrator.service';
import { ReconciliationService } from './reconciliation.service';
import { TicketDecompositionService } from './ticket-decomposition.service';

interface ResolveAgentConflictPayload {
  readonly ticketId: string;
  readonly conflictSummary: string;
  readonly proposedResolution: string;
}

@Module({
  imports: [AgentModule, HitlModule, BudgetModule, AuditModule],
  providers: [
    LedgerRepository,
    TicketDecompositionService,
    ReconciliationService,
    OrchestratorService,
  ],
  exports: [OrchestratorService, LedgerRepository],
})
export class OrchestratorModule implements OnModuleInit {
  constructor(
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
    private readonly ledger: LedgerRepository,
  ) {}

  onModuleInit(): void {
    // `resolveAgentConflict` (ADR 0005 punto 6): tool sintética que no
    // ejecuta ninguna acción externa — el "efecto" de aprobarla es
    // registrar la decisión del owner como comentario de resolución en
    // el ticket. Reusa el HITL/Telegram existente, sin canal nuevo.
    this.toolExecutorRegistry.register(
      'resolveAgentConflict',
      async (payload) => {
        const { ticketId, conflictSummary, proposedResolution } =
          payload as ResolveAgentConflictPayload;
        await this.ledger.addComment({
          ticketId,
          authorType: 'owner',
          kind: 'resolution',
          body: `${conflictSummary} — resuelto por el owner: ${proposedResolution}`,
        });
        return { ticketId, resolved: true };
      },
    );

    // `mergeAgentBranch` (ADR 0005 punto 9): declarada como guardrail,
    // sin implementación real — 501 documentado, mismo patrón que
    // `CalendarNotImplementedError`. Ver el ADR para el porqué.
    this.toolExecutorRegistry.register('mergeAgentBranch', () => {
      throw new AgentBranchMergeNotImplementedError();
    });
  }
}
