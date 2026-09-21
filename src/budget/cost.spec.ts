import { describe, expect, it } from 'vitest';
import type { ModelPrices } from '../model-provider/model-provider.types';
import { computeCostUsd, estimateTokens } from './cost';

describe('estimateTokens', () => {
  it('estima ~1 token cada 4 caracteres', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('redondea hacia arriba para no subestimar', () => {
    expect(estimateTokens('abc')).toBe(1);
  });

  it('texto vacío estima 0 tokens', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('computeCostUsd', () => {
  const prices: ModelPrices = {
    'claude-sonnet-5': { inputPerMillion: 3, outputPerMillion: 15 },
  };

  it('calcula el costo combinando input y output al precio por millón', () => {
    const cost = computeCostUsd(prices, 'claude-sonnet-5', 1_000_000, 500_000);
    // 1M input a $3/M = $3; 500k output a $15/M = $7.50
    expect(cost).toBeCloseTo(10.5, 6);
  });

  it('con 0 tokens el costo es 0', () => {
    expect(computeCostUsd(prices, 'claude-sonnet-5', 0, 0)).toBe(0);
  });

  it('lanza si el modelId no tiene precio configurado', () => {
    expect(() =>
      computeCostUsd(prices, 'modelo-inexistente', 100, 100),
    ).toThrow(/No hay precio configurado/);
  });

  // Regresión (2026-09-21): la API devuelve en `response.model` el id CON fecha
  // (`claude-haiku-4-5-20251001`) aunque se pida por alias. El cálculo de costo
  // de una llamada que SÍ se ejecutó explotaba con "No hay precio configurado".
  describe('snapshots con fecha', () => {
    const withHaiku: ModelPrices = {
      ...prices,
      'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
    };

    it('un id con sufijo de fecha usa el precio de su alias', () => {
      const cost = computeCostUsd(
        withHaiku,
        'claude-haiku-4-5-20251001',
        1_000_000,
        1_000_000,
      );
      expect(cost).toBeCloseTo(6, 6);
    });

    it('el precio exacto gana sobre el alias', () => {
      const exact: ModelPrices = {
        ...withHaiku,
        'claude-haiku-4-5-20251001': {
          inputPerMillion: 9,
          outputPerMillion: 9,
        },
      };
      expect(
        computeCostUsd(exact, 'claude-haiku-4-5-20251001', 1_000_000, 0),
      ).toBeCloseTo(9, 6);
    });

    it('NO hereda precio por prefijo suelto: un modelo desconocido sigue siendo un error', () => {
      // `claude-sonnet-5-5` no es un snapshot de `claude-sonnet-5`.
      expect(() => computeCostUsd(prices, 'claude-sonnet-5-5', 1, 1)).toThrow(
        /No hay precio configurado/,
      );
      // Sufijo de fecha de un modelo SIN alias configurado: error, no 0.
      expect(() =>
        computeCostUsd(prices, 'claude-opus-9-20260101', 1, 1),
      ).toThrow(/No hay precio configurado/);
    });
  });
});
