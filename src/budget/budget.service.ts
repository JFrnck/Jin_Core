import { Inject, Injectable } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { eq, sql } from 'drizzle-orm';
import type { Counter, Gauge } from 'prom-client';
import type { ModelPrices } from '../model-provider/model-provider.types';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { budgetDailyUsage, budgetHourlyUsage } from '../db/schema';
import {
  BUDGET_REMAINING_RATIO,
  TOKENS_CONSUMED_TOTAL,
} from '../metrics/metrics.module';
import {
  computeDailyUsageRatio,
  type DailyUsage,
  type SessionUsage,
  wouldExceedSessionBudget,
} from './budget.logic';
import { currentHourBucket, todayLocalDate } from './budget-time';
import { BUDGET_CONFIG, MODEL_PRICES } from './budget.tokens';
import type {
  BudgetConfig,
  CheckBeforeCallInput,
  CheckBeforeCallResult,
  RecordUsageInput,
} from './budget.types';
import { computeCostUsd } from './cost';
import { DailyBudgetExceededError, SessionBudgetExceededError } from './errors';

/**
 * Tracking de presupuesto por sesión/día (BLUEPRINT 9.6). Servicio
 * delgado — la matemática de umbrales vive en `budget.logic.ts` (pura,
 * testeada sin DB); acá solo se ensambla el dato real (Postgres +
 * mapa en memoria) y se llama a esa lógica. El acumulado de sesión vive
 * en memoria — a diferencia del diario/horario, perder una sesión en
 * curso tras un restart es de bajo impacto (peor caso: una tarea
 * puntual resetea su propio contador). El diario vive en Postgres
 * (`budget_daily_usage`), mismo motivo que `pendingApprovals`: un
 * límite que se olvida en cada restart no es un límite real.
 */
@Injectable()
export class BudgetService {
  private readonly sessionUsage = new Map<string, SessionUsage>();

  constructor(
    @Inject(DB_CONNECTION) private readonly db: Db,
    @Inject(BUDGET_CONFIG) private readonly config: BudgetConfig,
    @Inject(MODEL_PRICES) private readonly prices: ModelPrices,
    @InjectMetric(TOKENS_CONSUMED_TOTAL)
    private readonly tokensConsumedCounter: Counter<string>,
    @InjectMetric(BUDGET_REMAINING_RATIO)
    private readonly budgetRemainingGauge: Gauge<string>,
  ) {}

  /**
   * Verifica ANTES de llamar al modelo (BLUEPRINT 9.6: "verifica
   * presupuesto antes"). Usa una estimación de tokens de input, no el
   * conteo real (no existe todavía — la llamada ni siquiera ocurrió).
   * Lanza si la sesión o el día ya están en el 100%; si no, devuelve el
   * ratio restante del día para que el caller lo pase como hint
   * `budgetRemaining` a `ModelRouterService.complete()` (degradación al
   * 80% ya implementada en `router.logic.ts`, sin duplicarla acá).
   */
  async checkBeforeCall(
    input: CheckBeforeCallInput,
  ): Promise<CheckBeforeCallResult> {
    const session = this.sessionUsage.get(input.sessionId) ?? {
      inputTokens: 0,
      outputTokens: 0,
    };

    if (
      wouldExceedSessionBudget(
        session,
        input.estimatedInputTokens,
        input.maxOutputTokens,
        this.config,
      )
    ) {
      throw new SessionBudgetExceededError(input.sessionId);
    }

    const usedRatio = await this.getDailyUsageRatio();
    if (usedRatio >= 1) {
      throw new DailyBudgetExceededError();
    }

    return { budgetRemaining: Math.max(0, 1 - usedRatio) };
  }

  /**
   * Registra el uso REAL tras una llamada exitosa (tokens devueltos por
   * el provider, no la estimación de `checkBeforeCall`). Persistencia
   * diaria/horaria vía upsert atómico (`ON CONFLICT DO UPDATE ... SET x
   * = x + $incremento`) — evita perder incrementos bajo escrituras
   * concurrentes, ver `budget.service.integration.spec.ts`.
   */
  async recordUsage(input: RecordUsageInput): Promise<void> {
    const costUsd = computeCostUsd(
      this.prices,
      input.modelId,
      input.inputTokens,
      input.outputTokens,
    );

    const session = this.sessionUsage.get(input.sessionId) ?? {
      inputTokens: 0,
      outputTokens: 0,
    };
    this.sessionUsage.set(input.sessionId, {
      inputTokens: session.inputTokens + input.inputTokens,
      outputTokens: session.outputTokens + input.outputTokens,
    });

    const today = todayLocalDate();
    await this.db
      .insert(budgetDailyUsage)
      .values({
        date: today,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costUsd,
      })
      .onConflictDoUpdate({
        target: budgetDailyUsage.date,
        set: {
          inputTokens: sql`${budgetDailyUsage.inputTokens} + ${input.inputTokens}`,
          outputTokens: sql`${budgetDailyUsage.outputTokens} + ${input.outputTokens}`,
          costUsd: sql`${budgetDailyUsage.costUsd} + ${costUsd}`,
          updatedAt: sql`now()`,
        },
      });

    const hourBucket = currentHourBucket();
    await this.db
      .insert(budgetHourlyUsage)
      .values({
        hourBucket,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        costUsd,
      })
      .onConflictDoUpdate({
        target: budgetHourlyUsage.hourBucket,
        set: {
          inputTokens: sql`${budgetHourlyUsage.inputTokens} + ${input.inputTokens}`,
          outputTokens: sql`${budgetHourlyUsage.outputTokens} + ${input.outputTokens}`,
          costUsd: sql`${budgetHourlyUsage.costUsd} + ${costUsd}`,
        },
      });

    this.tokensConsumedCounter.inc(
      { model: input.modelId, task_type: input.taskProfile },
      input.inputTokens + input.outputTokens,
    );
    const remainingRatio = 1 - (await this.getDailyUsageRatio());
    this.budgetRemainingGauge.set(Math.max(0, remainingRatio));
  }

  /**
   * Consumo acumulado en memoria de una sesión (Fase 5.4, ADR 0005): el
   * orquestador lo usa para sumar el presupuesto real de cada sub-agente
   * (sessionId derivado `{runId}:{ticketId}`) al cerrar un run
   * multi-agente. `{inputTokens: 0, outputTokens: 0}` si la sesión nunca
   * llamó a `recordUsage` (ej. no llegó a invocar el modelo).
   */
  getSessionUsage(sessionId: string): SessionUsage {
    return (
      this.sessionUsage.get(sessionId) ?? { inputTokens: 0, outputTokens: 0 }
    );
  }

  /**
   * Ratio 0-1 de cuánto del presupuesto diario ya se consumió. Público
   * — lo usa también el watcher de alertas de Telegram (80%/100%).
   */
  async getDailyUsageRatio(): Promise<number> {
    const daily = await this.getDailyUsage();
    return computeDailyUsageRatio(daily, this.config);
  }

  /**
   * Consumo real del día (tokens + costo) — público desde Fase 6.2
   * (`BudgetController`, panel de presupuesto): el ratio por sí solo no
   * alcanza para mostrar "$4.31 / $5.00", el dashboard necesita el
   * desglose real.
   */
  async getDailyUsage(): Promise<DailyUsage> {
    const today = todayLocalDate();
    const rows = await this.db
      .select()
      .from(budgetDailyUsage)
      .where(eq(budgetDailyUsage.date, today));
    const row = rows[0];
    return row
      ? {
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          costUsd: row.costUsd,
        }
      : { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }

  /**
   * Límites diarios configurados — el dashboard los necesita para
   * mostrar "consumido / límite", no solo el ratio ya calculado.
   */
  getLimits(): { dailyMaxTokens: number; dailyMaxUsd: number } {
    return {
      dailyMaxTokens: this.config.dailyMaxTokens,
      dailyMaxUsd: this.config.dailyMaxUsd,
    };
  }
}
