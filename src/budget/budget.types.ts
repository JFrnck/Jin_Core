export interface BudgetConfig {
  readonly sessionMaxInputTokens: number;
  readonly sessionMaxOutputTokens: number;
  readonly dailyMaxTokens: number;
  readonly dailyMaxUsd: number;
  readonly runawayMultiplier: number;
  readonly runawayLookbackHours: number;
  /**
   * Piso absoluto de tokens en la hora actual por DEBAJO del cual nunca hay
   * runaway, sin importar la razón contra el promedio. Ver `isRunawayDetected`.
   */
  readonly runawayMinHourlyTokens: number;
}

export interface CheckBeforeCallInput {
  readonly sessionId: string;
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
}

export interface CheckBeforeCallResult {
  /** Ratio 0-1 de presupuesto diario restante (1 = nada consumido). */
  readonly budgetRemaining: number;
}

export interface RecordUsageInput {
  readonly sessionId: string;
  readonly modelId: string;
  /** Para la etiqueta `task_type` de la métrica `tokens_consumed_total`. */
  readonly taskProfile: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}
