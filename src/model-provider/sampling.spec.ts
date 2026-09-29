import { describe, expect, it } from 'vitest';
import {
  anthropicMaxTokens,
  anthropicModelAcceptsSampling,
  anthropicThinkingParams,
} from './sampling';

describe('anthropicMaxTokens (pensamiento siempre prendido come del mismo tope)', () => {
  it('Opus 5.5 / Sonnet 5.5: sube el tope de 8000 a 16000', () => {
    expect(anthropicMaxTokens('claude-sonnet-5-5', 8000)).toBe(16_000);
    expect(anthropicMaxTokens('claude-opus-5-5', 1000)).toBe(16_000);
  });
  it('nunca baja un tope ya más alto', () => {
    expect(anthropicMaxTokens('claude-opus-5-5', 20_000)).toBe(20_000);
  });
  it('el resto no cambia', () => {
    expect(anthropicMaxTokens('claude-sonnet-5', 8000)).toBe(8000);
    expect(anthropicMaxTokens('claude-haiku-4-5', 1000)).toBe(1000);
  });
});

describe('anthropicModelAcceptsSampling', () => {
  it.each([
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-mythos-5-1',
    'claude-opus-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-sonnet-5',
    'claude-sonnet-5-20260601',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
  ])('%s NO acepta parámetros de muestreo', (id) => {
    expect(anthropicModelAcceptsSampling(id)).toBe(false);
  });

  it.each([
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
    'claude-haiku-4-5-20251001',
  ])('%s todavía los acepta', (id) => {
    expect(anthropicModelAcceptsSampling(id)).toBe(true);
  });

  it('un id de otra familia con prefijo parecido no queda excluido por error', () => {
    // `claude-sonnet-4-6` empieza por `claude-sonnet-`, pero no por `claude-sonnet-5`.
    expect(anthropicModelAcceptsSampling('claude-sonnet-4-6')).toBe(true);
  });
});

describe('anthropicThinkingParams (2026-09-28, preferencia de modelo del owner)', () => {
  it('sin effort: no manda nada (el modelo se comporta con su default de siempre)', () => {
    expect(anthropicThinkingParams('claude-sonnet-5', undefined, 8000)).toEqual(
      {},
    );
    expect(
      anthropicThinkingParams('claude-haiku-4-5', undefined, 8000),
    ).toEqual({});
  });

  describe('generación con adaptive thinking (Sonnet 5, Opus 4.7/4.8)', () => {
    it('low: apaga el pensamiento explícitamente', () => {
      expect(anthropicThinkingParams('claude-sonnet-5', 'low', 8000)).toEqual({
        thinking: { type: 'disabled' },
      });
      expect(anthropicThinkingParams('claude-opus-4-8', 'low', 8000)).toEqual({
        thinking: { type: 'disabled' },
      });
    });

    it.each(['medium', 'high'] as const)(
      '%s: prende adaptive thinking con ese esfuerzo',
      (effort) => {
        expect(
          anthropicThinkingParams('claude-sonnet-5', effort, 8000),
        ).toEqual({
          thinking: { type: 'adaptive' },
          output_config: { effort },
        });
      },
    );
  });

  describe('generación con pensamiento SIEMPRE prendido (Opus 5.5, Sonnet 5.5)', () => {
    it('low: NO manda "disabled" (la API lo rechaza con 400) — manda adaptive con effort low', () => {
      expect(anthropicThinkingParams('claude-opus-5-5', 'low', 8000)).toEqual({
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
      });
      expect(anthropicThinkingParams('claude-sonnet-5-5', 'low', 8000)).toEqual(
        {
          thinking: { type: 'adaptive' },
          output_config: { effort: 'low' },
        },
      );
    });

    it.each(['medium', 'high'] as const)(
      '%s: igual que el resto de la generación, adaptive con ese esfuerzo',
      (effort) => {
        expect(
          anthropicThinkingParams('claude-opus-5-5', effort, 8000),
        ).toEqual({
          thinking: { type: 'adaptive' },
          output_config: { effort },
        });
      },
    );

    it('con sufijo de fecha, sigue matcheando por prefijo', () => {
      expect(
        anthropicThinkingParams('claude-sonnet-5-5-20261001', 'low', 8000),
      ).toEqual({
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
      });
    });
  });

  describe('generación anterior sin adaptive thinking (Haiku 4.5)', () => {
    it('low: no manda thinking en absoluto (no solo "disabled" — el modelo no tiene ese modo)', () => {
      expect(anthropicThinkingParams('claude-haiku-4-5', 'low', 8000)).toEqual(
        {},
      );
    });

    it('medium/high: usa budget_tokens clásico, más grande en high', () => {
      // maxOutputTokens generoso: ninguno de los dos deseados (2048/8192) se achica.
      const medium = anthropicThinkingParams(
        'claude-haiku-4-5',
        'medium',
        16_000,
      );
      const high = anthropicThinkingParams('claude-haiku-4-5', 'high', 16_000);
      expect(medium).toEqual({
        thinking: { type: 'enabled', budget_tokens: 2048 },
      });
      expect(high).toEqual({
        thinking: { type: 'enabled', budget_tokens: 8192 },
      });
    });

    it('el budget_tokens nunca llega a max_tokens (mínimo 1024 exigido por la API): con poco margen, se achica; sin margen, se omite', () => {
      // 8192 (deseado en high) > 3000 - 512: se achica a 2488.
      expect(anthropicThinkingParams('claude-haiku-4-5', 'high', 3000)).toEqual(
        {
          thinking: { type: 'enabled', budget_tokens: 2488 },
        },
      );
      // Con maxOutputTokens muy chico, ni el mínimo de 1024 entra con margen: se omite.
      expect(
        anthropicThinkingParams('claude-haiku-4-5', 'medium', 1200),
      ).toEqual({});
    });
  });
});
