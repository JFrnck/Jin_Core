import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { z } from 'zod';
import type { BudgetConfig } from './budget.types';

// Espejo snake_case de config/budget.yaml — mismo patrón que
// src/model-provider/models-config.schema.ts.
const BudgetYamlSchema = z.object({
  session_max_input_tokens: z.number().int().positive(),
  session_max_output_tokens: z.number().int().positive(),
  daily_max_tokens: z.number().int().positive(),
  daily_max_usd: z.number().positive(),
  runaway_multiplier: z.number().positive(),
  runaway_lookback_hours: z.number().int().positive(),
  runaway_min_hourly_tokens: z.number().int().positive(),
});

/**
 * Fail-fast (AGENTS.md 8.4): un `config/budget.yaml` malformado lanza al
 * arrancar, antes de que cualquier llamada al ModelProvider dependa de
 * un límite indefinido.
 */
export function parseBudgetConfig(raw: unknown): BudgetConfig {
  const result = BudgetYamlSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`config/budget.yaml inválido:\n${issues}`);
  }

  const data = result.data;
  return {
    sessionMaxInputTokens: data.session_max_input_tokens,
    sessionMaxOutputTokens: data.session_max_output_tokens,
    dailyMaxTokens: data.daily_max_tokens,
    dailyMaxUsd: data.daily_max_usd,
    runawayMultiplier: data.runaway_multiplier,
    runawayLookbackHours: data.runaway_lookback_hours,
    runawayMinHourlyTokens: data.runaway_min_hourly_tokens,
  };
}

export function loadBudgetConfig(filePath: string): BudgetConfig {
  const fileContents = readFileSync(filePath, 'utf-8');
  const raw = load(fileContents);
  return parseBudgetConfig(raw);
}
