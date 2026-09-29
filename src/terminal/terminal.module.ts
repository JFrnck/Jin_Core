import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { HitlModule } from '../hitl/hitl.module';
import { OwnerTerminalService } from './owner-terminal.service';
import { TerminalExecutorClient } from './terminal-executor.client';
import { TerminalController } from './terminal.controller';
import { TerminalGateway } from './terminal.gateway';
import { TerminalPtyService } from './terminal-pty.service';

@Module({
  imports: [HitlModule, AuditModule, AuthModule],
  controllers: [TerminalController],
  providers: [
    TerminalExecutorClient,
    OwnerTerminalService,
    TerminalPtyService,
    TerminalGateway,
  ],
})
export class TerminalModule {}
