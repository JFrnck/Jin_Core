import { describe, expect, it } from 'vitest';
import type { BudgetConfig } from './budget.types';
import { isRunawayDetected } from './kill-switch.logic';

const CONFIG: BudgetConfig = {
  sessionMaxInputTokens: 500_000,
  sessionMaxOutputTokens: 100_000,
  dailyMaxTokens: 5_000_000,
  dailyMaxUsd: 10,
  runawayMultiplier: 2,
  runawayLookbackHours: 24,
  // Piso simbólico: estos casos miden la RAZÓN contra el promedio con cifras chicas.
  runawayMinHourlyTokens: 100,
};

function makeHours(tokensPerHour: number, count = 24) {
  return Array.from({ length: count }, (_, i) => ({
    hourBucket: new Date(2026, 0, 1, i),
    inputTokens: tokensPerHour,
    outputTokens: 0,
  }));
}

describe('isRunawayDetected', () => {
  it('false sin historial de lookback (arranque en frío)', () => {
    expect(isRunawayDetected(1_000_000, [], CONFIG)).toBe(false);
  });

  it('false con consumo normal (igual al promedio histórico)', () => {
    const lookback = makeHours(1000); // promedio 1000/h
    expect(isRunawayDetected(1000, lookback, CONFIG)).toBe(false);
  });

  it('false justo por debajo del multiplicador (2x exacto no es ">", es límite)', () => {
    const lookback = makeHours(1000); // promedio 1000/h
    expect(isRunawayDetected(2000, lookback, CONFIG)).toBe(false);
  });

  it('true apenas por encima del multiplicador', () => {
    const lookback = makeHours(1000); // promedio 1000/h
    expect(isRunawayDetected(2001, lookback, CONFIG)).toBe(true);
  });

  it('true con un runaway claro (10x el promedio)', () => {
    const lookback = makeHours(1000);
    expect(isRunawayDetected(10_000, lookback, CONFIG)).toBe(true);
  });

  it('false si el promedio histórico es 0 (nunca hubo consumo — evita división engañosa)', () => {
    const lookback = makeHours(0);
    expect(isRunawayDetected(500, lookback, CONFIG)).toBe(false);
  });

  it('usa runawayLookbackHours de la config, no la cantidad de filas recibidas', () => {
    // Solo 5 filas de historial (no 24) pero runawayLookbackHours=24:
    // el promedio se divide entre 24 igual, no entre 5 — un historial
    // parcial no debe inflar artificialmente el promedio.
    const lookback = makeHours(2400, 5); // total = 12000
    // avgHourlyUsage = 12000/24 = 500, no 12000/5=2400
    expect(isRunawayDetected(1001, lookback, CONFIG)).toBe(true); // 1001 > 500*2
    expect(isRunawayDetected(999, lookback, CONFIG)).toBe(false); // 999 < 1000
  });

  // Regresión (2026-09-21, primer uso real): el kill switch pausó TODO con 5 487
  // tokens (~$0.02) porque el promedio de 24 h era ~208 tokens/h (una sola hora
  // de historial dividida entre 24). Con la razón sola, cualquier conversación
  // normal en un sistema recién desplegado parece un desastre.
  describe('piso absoluto (runawayMinHourlyTokens)', () => {
    const REAL: BudgetConfig = { ...CONFIG, runawayMinHourlyTokens: 500_000 };

    it('el incidente real: 5 487 tokens contra una sola hora de historial NO es runaway', () => {
      const oneHourOfHistory = makeHours(5000, 1); // 5000/24 ~ 208 tokens/h de promedio
      // Sin el piso esto era true: 5487 > 208 * 2 (26x).
      expect(isRunawayDetected(5487, oneHourOfHistory, CONFIG)).toBe(true);
      expect(isRunawayDetected(5487, oneHourOfHistory, REAL)).toBe(false);
    });

    it('por debajo del piso NUNCA hay runaway, aunque la razón sea absurda (1000x)', () => {
      const lookback = makeHours(10); // promedio 10/h
      expect(isRunawayDetected(499_999, lookback, REAL)).toBe(false);
    });

    it('un proceso por lotes legítimo (análisis nocturno) por debajo del piso no pausa el sistema', () => {
      // Gasta en una hora lo que el resto del día no: 200k tokens contra un promedio de ~4k/h.
      const lookback = makeHours(4000);
      expect(isRunawayDetected(200_000, lookback, REAL)).toBe(false);
    });

    it('por encima del piso Y de la razón SÍ es runaway (un agente en bucle)', () => {
      const lookback = makeHours(4000);
      expect(isRunawayDetected(2_000_000, lookback, REAL)).toBe(true);
    });

    it('por encima del piso pero con razón normal NO es runaway (uso sostenido alto)', () => {
      const lookback = makeHours(400_000); // ya se gasta mucho de forma habitual
      expect(isRunawayDetected(600_000, lookback, REAL)).toBe(false);
    });

    it('justo en el piso cuenta como por encima (>=), no como por debajo', () => {
      const lookback = makeHours(1000);
      expect(isRunawayDetected(500_000, lookback, REAL)).toBe(true);
    });
  });
});
