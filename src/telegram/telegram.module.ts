import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { AuditModule } from '../audit/audit.module';
import { BudgetModule } from '../budget/budget.module';
import { HitlModule } from '../hitl/hitl.module';
import { GoogleModule } from '../integrations/google/google.module';
import { MemoryModule } from '../memory/memory.module';
import { TelegramBotService } from './telegram-bot.service';
import { TelegramWebhookController } from './telegram-webhook.controller';

@Module({
  imports: [
    AuditModule,
    HitlModule,
    BudgetModule,
    GoogleModule,
    AgentModule,
    MemoryModule,
  ],
  controllers: [TelegramWebhookController],
  providers: [TelegramBotService],
  exports: [TelegramBotService],
})
export class TelegramModule {}
