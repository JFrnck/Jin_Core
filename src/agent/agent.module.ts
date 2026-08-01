import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BudgetModule } from '../budget/budget.module';
import { HitlModule } from '../hitl/hitl.module';
import { loadAgentConfig, type AgentConfig } from './agent-config.schema';
import { AGENT_CONFIG } from './agent.tokens';
import { AgentService } from './agent.service';

const AGENT_CONFIG_PATH = join(process.cwd(), 'config', 'agent.yaml');

@Module({
  imports: [BudgetModule, HitlModule, AuditModule],
  providers: [
    {
      provide: AGENT_CONFIG,
      useFactory: (): AgentConfig => loadAgentConfig(AGENT_CONFIG_PATH),
    },
    AgentService,
  ],
  // AGENT_CONFIG exportado además de AgentService: OrchestratorModule
  // (Fase 5.4) también lo necesita (max_concurrent_sub_agents), sin
  // duplicar la carga de config/agent.yaml en dos factories distintas.
  exports: [AgentService, AGENT_CONFIG],
})
export class AgentModule {}
