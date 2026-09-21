import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBudgetConfig, parseBudgetConfig } from './budget-config.schema';

function validRawConfig(overrides: Record<string, unknown> = {}) {
  return {
    session_max_input_tokens: 500_000,
    session_max_output_tokens: 100_000,
    daily_max_tokens: 5_000_000,
    daily_max_usd: 10,
    runaway_multiplier: 2,
    runaway_lookback_hours: 24,
    runaway_min_hourly_tokens: 500_000,
    ...overrides,
  };
}

describe('parseBudgetConfig', () => {
  it('traduce snake_case del YAML a camelCase de BudgetConfig', () => {
    const config = parseBudgetConfig(validRawConfig());
    expect(config).toEqual({
      sessionMaxInputTokens: 500_000,
      sessionMaxOutputTokens: 100_000,
      dailyMaxTokens: 5_000_000,
      dailyMaxUsd: 10,
      runawayMultiplier: 2,
      runawayLookbackHours: 24,
      runawayMinHourlyTokens: 500_000,
    });
  });

  it('lanza si falta un campo requerido', () => {
    const raw = validRawConfig() as Record<string, unknown>;
    delete raw.daily_max_usd;

    expect(() => parseBudgetConfig(raw)).toThrow(
      /config\/budget\.yaml inválido/,
    );
  });

  it('exige el piso del kill switch: sin él el detector se dispara con cualquier uso normal en frío', () => {
    const raw = validRawConfig() as Record<string, unknown>;
    delete raw.runaway_min_hourly_tokens;

    expect(() => parseBudgetConfig(raw)).toThrow(/runaway_min_hourly_tokens/);
    expect(() =>
      parseBudgetConfig(validRawConfig({ runaway_min_hourly_tokens: 0 })),
    ).toThrow();
  });

  it('lanza si un campo numérico es negativo o cero', () => {
    expect(() =>
      parseBudgetConfig(validRawConfig({ daily_max_usd: 0 })),
    ).toThrow();
    expect(() =>
      parseBudgetConfig(validRawConfig({ session_max_input_tokens: -1 })),
    ).toThrow();
  });

  it('lanza si un campo tiene tipo incorrecto', () => {
    expect(() =>
      parseBudgetConfig(validRawConfig({ runaway_multiplier: 'dos' })),
    ).toThrow();
  });

  it('lanza si el input no tiene la forma esperada en absoluto', () => {
    expect(() => parseBudgetConfig({})).toThrow();
    expect(() => parseBudgetConfig(null)).toThrow();
  });
});

describe('loadBudgetConfig', () => {
  it('carga y valida el config/budget.yaml real del repo sin lanzar', () => {
    const realPath = join(process.cwd(), 'config', 'budget.yaml');
    const config = loadBudgetConfig(realPath);

    expect(config.dailyMaxUsd).toBe(10);
    expect(config.runawayMultiplier).toBe(2);
    // El piso real del repo protege del falso positivo del primer uso (2026-09-21).
    expect(config.runawayMinHourlyTokens).toBe(500_000);
  });
});
