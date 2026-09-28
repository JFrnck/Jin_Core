import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { HitlModule } from '../hitl/hitl.module';
import { OwnerTerminalService } from './owner-terminal.service';
import { TerminalExecutorClient } from './terminal-executor.client';
import { TerminalController } from './terminal.controller';

@Module({
  imports: [HitlModule, AuditModule],
  controllers: [TerminalController],
  providers: [TerminalExecutorClient, OwnerTerminalService],
})
export class TerminalModule {}
