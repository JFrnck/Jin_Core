import { describe, expect, it } from 'vitest';
import type { BudgetConfig } from './budget.types';
import {
  computeDailyUsageRatio,
  wouldExceedSessionBudget,
} from './budget.logic';

const CONFIG: BudgetConfig = {
  sessionMaxInputTokens: 500_000,
  sessionMaxOutputTokens: 100_000,
  dailyMaxTokens: 5_000_000,
  dailyMaxUsd: 10,
  runawayMultiplier: 2,
  runawayLookbackHours: 24,
  runawayMinHourlyTokens: 100,
};

describe('computeDailyUsageRatio', () => {
  it('devuelve 0 sin consumo', () => {
    expect(
      computeDailyUsageRatio(
        { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        CONFIG,
      ),
    ).toBe(0);
  });

  it('usa el ratio de tokens cuando es el más alto', () => {
    const ratio = computeDailyUsageRatio(
      { inputTokens: 2_000_000, outputTokens: 2_500_000, costUsd: 1 },
      CONFIG,
    );
    // (2M+2.5M)/5M = 0.9 vs 1/10 = 0.1 → gana tokens
    expect(ratio).toBeCloseTo(0.9, 6);
  });

  it('usa el ratio de USD cuando es el más alto (mismo criterio, al revés)', () => {
    const ratio = computeDailyUsageRatio(
      { inputTokens: 100_000, outputTokens: 100_000, costUsd: 9 },
      CONFIG,
    );
    // 200k/5M = 0.04 vs 9/10 = 0.9 → gana USD
    expect(ratio).toBeCloseTo(0.9, 6);
  });

  it('el ratio de 80% consumido coincide exactamente con budgetRemaining=0.2 (umbral de degradación del router)', () => {
    const ratio = computeDailyUsageRatio(
      { inputTokens: 4_000_000, outputTokens: 0, costUsd: 0 },
      CONFIG,
    );
    expect(ratio).toBeCloseTo(0.8, 6);
    expect(1 - ratio).toBeCloseTo(0.2, 6);
  });

  it('puede superar 1.0 si el consumo excede el límite — no se clampa acá', () => {
    const ratio = computeDailyUsageRatio(
      { inputTokens: 6_000_000, outputTokens: 0, costUsd: 0 },
      CONFIG,
    );
    expect(ratio).toBeGreaterThan(1);
  });
});

describe('wouldExceedSessionBudget', () => {
  it('false si la llamada entra dentro de los límites de sesión', () => {
    expect(
      wouldExceedSessionBudget(
        { inputTokens: 0, outputTokens: 0 },
        100_000,
        10_000,
        CONFIG,
      ),
    ).toBe(false);
  });

  it('true si el input proyectado supera sessionMaxInputTokens', () => {
    expect(
      wouldExceedSessionBudget(
        { inputTokens: 450_000, outputTokens: 0 },
        60_000,
        1000,
        CONFIG,
      ),
    ).toBe(true);
  });

  it('true si el output proyectado supera sessionMaxOutputTokens, aunque el input esté OK', () => {
    expect(
      wouldExceedSessionBudget(
        { inputTokens: 0, outputTokens: 95_000 },
        1000,
        10_000,
        CONFIG,
      ),
    ).toBe(true);
  });

  it('exactamente en el límite (=) no excede — el corte es estrictamente mayor', () => {
    expect(
      wouldExceedSessionBudget(
        { inputTokens: 0, outputTokens: 0 },
        CONFIG.sessionMaxInputTokens,
        CONFIG.sessionMaxOutputTokens,
        CONFIG,
      ),
    ).toBe(false);
  });
});
