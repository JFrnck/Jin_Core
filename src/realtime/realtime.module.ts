import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BudgetModule } from '../budget/budget.module';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [AuthModule, BudgetModule],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
