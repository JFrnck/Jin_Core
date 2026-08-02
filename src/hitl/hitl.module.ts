import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ApprovalExecutionService } from './approval-execution.service';
import { DualConfirmService } from './dual-confirm.service';
import { HitlController } from './hitl.controller';
import { TimeoutService } from './timeout.service';
import { ToolExecutorRegistry } from './tool-executor.registry';

@Module({
  imports: [AuditModule],
  controllers: [HitlController],
  providers: [
    DualConfirmService,
    TimeoutService,
    ToolExecutorRegistry,
    ApprovalExecutionService,
  ],
  exports: [
    DualConfirmService,
    TimeoutService,
    ToolExecutorRegistry,
    ApprovalExecutionService,
  ],
})
export class HitlModule {}
