import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { loadModelPrices } from '../model-provider/models-config.schema';
import type { ModelPrices } from '../model-provider/model-provider.types';
import { ModelProviderModule } from '../model-provider/model-provider.module';
import { MetricsModule } from '../metrics/metrics.module';
import { BudgetController } from './budget.controller';
import { loadBudgetConfig } from './budget-config.schema';
import { BudgetGuardedModelRouter } from './budget-guarded-router.service';
import { BUDGET_CONFIG, MODEL_PRICES } from './budget.tokens';
import type { BudgetConfig } from './budget.types';
import { BudgetService } from './budget.service';
import { KillSwitchService } from './kill-switch.service';

const BUDGET_CONFIG_PATH = join(process.cwd(), 'config', 'budget.yaml');
const MODELS_CONFIG_PATH = join(process.cwd(), 'config', 'models.yaml');

@Module({
  imports: [ModelProviderModule, MetricsModule, AuditModule],
  controllers: [BudgetController],
  providers: [
    {
      provide: BUDGET_CONFIG,
      useFactory: (): BudgetConfig => loadBudgetConfig(BUDGET_CONFIG_PATH),
    },
    {
      provide: MODEL_PRICES,
      useFactory: (): ModelPrices => loadModelPrices(MODELS_CONFIG_PATH),
    },
    BudgetService,
    KillSwitchService,
    BudgetGuardedModelRouter,
  ],
  exports: [BudgetService, KillSwitchService, BudgetGuardedModelRouter],
})
export class BudgetModule {}
