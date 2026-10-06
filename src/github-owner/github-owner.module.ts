import { Module, type OnModuleInit } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { HitlModule } from '../hitl/hitl.module';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { HitlPolicyModule } from '../hitl-policy/hitl-policy.module';
import { GithubExecutorClient } from './github-executor.client';
import { GithubOwnerController } from './github-owner.controller';
import { OwnerGithubService, PUSH_TOOL_NAME } from './owner-github.service';

/** GitHub desde la app del owner (ADR 0022). El token de la GitHub App vive solo en el Executor. */
@Module({
  imports: [HitlModule, HitlPolicyModule, AuditModule],
  controllers: [GithubOwnerController],
  providers: [GithubExecutorClient, OwnerGithubService],
})
export class GithubOwnerModule implements OnModuleInit {
  constructor(
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
    private readonly github: OwnerGithubService,
  ) {}

  onModuleInit(): void {
    // La aprobación del owner ejecuta el push (el payload sale del registro de aprobaciones).
    this.toolExecutorRegistry.register(PUSH_TOOL_NAME, (payload) =>
      this.github.executePush(payload),
    );
  }
}
