import { Module } from '@nestjs/common';
import {
  makeCounterProvider,
  makeGaugeProvider,
  PrometheusModule,
} from '@willsoto/nestjs-prometheus';

// Nombres exactos de docs/BLUEPRINT.md §10.1 y §4.1 de PROMPTS.md — no
// cambiar sin actualizar ambos docs (MODEL_ROUTING.md §6.3 aplica el
// mismo criterio a los modelos).
export const TOKENS_CONSUMED_TOTAL = 'tokens_consumed_total';
export const BUDGET_REMAINING_RATIO = 'budget_remaining_ratio';
export const RUNAWAY_DETECTED_TOTAL = 'runaway_detected_total';

const tokensConsumedCounter = makeCounterProvider({
  name: TOKENS_CONSUMED_TOTAL,
  help: 'Tokens consumidos por llamada al ModelProvider (BLUEPRINT 10.1).',
  labelNames: ['model', 'task_type'],
});

const budgetRemainingGauge = makeGaugeProvider({
  name: BUDGET_REMAINING_RATIO,
  help: 'Ratio 0-1 de presupuesto diario restante (BLUEPRINT 9.6/10.1).',
});

const runawayDetectedCounter = makeCounterProvider({
  name: RUNAWAY_DETECTED_TOTAL,
  help: 'Veces que el kill switch detectó un consumo runaway (BLUEPRINT 9.6/10.1).',
});

/**
 * Expone `/metrics` (Prometheus, ya desplegado en Jin_Infra —
 * Fase 1.1). Solo las 3 métricas que Fase 4.1 exige explícitamente
 * (PROMPTS.md §4.1); otras de BLUEPRINT §10.1 (`tool_latency_seconds`,
 * `hitl_approval_rate`, etc.) quedan fuera de alcance de esta fase.
 */
@Module({
  imports: [PrometheusModule.register()],
  providers: [
    tokensConsumedCounter,
    budgetRemainingGauge,
    runawayDetectedCounter,
  ],
  exports: [
    tokensConsumedCounter,
    budgetRemainingGauge,
    runawayDetectedCounter,
  ],
})
export class MetricsModule {}
