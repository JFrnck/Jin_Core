import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BudgetModule } from '../budget/budget.module';
import { FeatureFlagsModule } from '../feature-flags/feature-flags.module';
import { HitlModule } from '../hitl/hitl.module';
import { HitlPolicyModule } from '../hitl-policy/hitl-policy.module';
import { MemoryModule } from '../memory/memory.module';
import { loadAgentConfig, type AgentConfig } from './agent-config.schema';
import { AGENT_CONFIG } from './agent.tokens';
import { AgentService } from './agent.service';
import { HistoryCompactionService } from './history-compaction.service';

const AGENT_CONFIG_PATH = join(process.cwd(), 'config', 'agent.yaml');

@Module({
  imports: [
    BudgetModule,
    HitlModule,
    AuditModule,
    MemoryModule,
    FeatureFlagsModule,
    HitlPolicyModule,
  ],
  providers: [
    {
      provide: AGENT_CONFIG,
      useFactory: (): AgentConfig => loadAgentConfig(AGENT_CONFIG_PATH),
    },
    HistoryCompactionService,
    AgentService,
  ],
  // AGENT_CONFIG exportado además de AgentService: OrchestratorModule
  // (Fase 5.4) también lo necesita (max_concurrent_sub_agents), sin
  // duplicar la carga de config/agent.yaml en dos factories distintas.
  exports: [AgentService, AGENT_CONFIG],
})
export class AgentModule {}
