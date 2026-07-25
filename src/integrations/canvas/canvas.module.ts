import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module';
import { BudgetModule } from '../../budget/budget.module';
import { GoogleModule } from '../google/google.module';
import { CanvasClientService } from './canvas-client.service';
import { CanvasToolsService } from './canvas-tools.service';
import { ShadowingService } from './shadowing.service';

@Module({
  imports: [AuditModule, BudgetModule, GoogleModule],
  providers: [CanvasClientService, CanvasToolsService, ShadowingService],
  exports: [CanvasClientService, CanvasToolsService, ShadowingService],
})
export class CanvasModule {}
