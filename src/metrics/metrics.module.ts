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
export const RAG_HIT_RATIO = 'rag_hit_ratio';

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

// Fase 9.3: hit = una búsqueda en el corpus (src/corpus/) devolvió >=1
// resultado; miss = 0 resultados. `CorpusService` la actualiza tras cada
// `search()` con contadores en memoria del proceso -- se resetea en
// cada restart, mismo criterio que `budgetRemainingGauge` (instantánea,
// no un acumulado histórico).
const ragHitRatioGauge = makeGaugeProvider({
  name: RAG_HIT_RATIO,
  help: 'Ratio 0-1 de búsquedas al corpus que devolvieron >=1 resultado (BLUEPRINT 10.1).',
});

/**
 * Expone `/metrics` (Prometheus, ya desplegado en Jin_Infra —
 * Fase 1.1). Solo las métricas que fases concretas exigen
 * explícitamente (PROMPTS.md §4.1, §9.3); otras de BLUEPRINT §10.1
 * (`tool_latency_seconds`, `hitl_approval_rate`, etc.) quedan fuera de
 * alcance.
 */
@Module({
  imports: [PrometheusModule.register()],
  providers: [
    tokensConsumedCounter,
    budgetRemainingGauge,
    runawayDetectedCounter,
    ragHitRatioGauge,
  ],
  exports: [
    tokensConsumedCounter,
    budgetRemainingGauge,
    runawayDetectedCounter,
    ragHitRatioGauge,
  ],
})
export class MetricsModule {}
