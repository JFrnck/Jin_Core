import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadModelPrices,
  loadModelsConfig,
  parseModelPrices,
  parseModelsConfig,
} from './models-config.schema';

function validRawProfile(overrides: Record<string, unknown> = {}) {
  return {
    description: 'x',
    primary: 'claude-opus-4-8',
    fallback: 'claude-sonnet-5',
    max_tokens_input: 100_000,
    max_tokens_output: 4000,
    temperature: 0.3,
    ...overrides,
  };
}

function validRawConfig(
  profileOverrides: Record<string, unknown> = {},
): unknown {
  const profile = validRawProfile(profileOverrides);
  return {
    profiles: {
      reasoning_heavy: profile,
      coding_default: profile,
      long_context: profile,
      extraction_fast: profile,
      chat_conversational: profile,
      code_execution_planner: profile,
      memory_consolidation: profile,
      history_compaction: profile,
      vision_analysis: profile,
    },
  };
}

describe('parseModelsConfig', () => {
  it('traduce snake_case del YAML a camelCase de ModelProfileConfig', () => {
    const config = parseModelsConfig(validRawConfig());
    expect(config.reasoning_heavy).toEqual({
      description: 'x',
      primary: 'claude-opus-4-8',
      fallback: 'claude-sonnet-5',
      maxTokensInput: 100_000,
      maxTokensOutput: 4000,
      temperature: 0.3,
    });
  });

  it('lanza si falta uno de los 9 profiles requeridos', () => {
    const raw = validRawConfig() as { profiles: Record<string, unknown> };
    delete raw.profiles.vision_analysis;

    expect(() => parseModelsConfig(raw)).toThrow(
      /config\/models\.yaml inválido/,
    );
  });

  it('lanza si un profile tiene un campo con tipo incorrecto', () => {
    const raw = validRawConfig({ temperature: 'no-es-un-numero' });

    expect(() => parseModelsConfig(raw)).toThrow(
      /config\/models\.yaml inválido/,
    );
  });

  it('lanza si primary/fallback están vacíos', () => {
    const raw = validRawConfig({ primary: '' });

    expect(() => parseModelsConfig(raw)).toThrow();
  });

  it('lanza si el input no tiene la forma esperada en absoluto', () => {
    expect(() => parseModelsConfig({ nada_que_ver: true })).toThrow();
    expect(() => parseModelsConfig(null)).toThrow();
  });
});

describe('loadModelsConfig', () => {
  it('carga y valida el config/models.yaml real del repo sin lanzar', () => {
    const realPath = join(process.cwd(), 'config', 'models.yaml');
    const config = loadModelsConfig(realPath);

    // No repite los 8 profiles completos (ya cubierto arriba) — solo
    // confirma que el archivo real en disco matchea el schema y trae al
    // menos el profile que usa Fase 3.1 (Canvas/shadowing).
    expect(config.long_context.primary).toBe('gemini-3.1-pro');
  });
});

describe('parseModelPrices', () => {
  it('traduce snake_case a camelCase de ModelPrice', () => {
    const prices = parseModelPrices({
      model_prices: {
        'claude-sonnet-5': { input_per_million: 3, output_per_million: 15 },
      },
    });
    expect(prices['claude-sonnet-5']).toEqual({
      inputPerMillion: 3,
      outputPerMillion: 15,
    });
  });

  it('acepta un mapa abierto de modelIds sin restringir a un set fijo', () => {
    const prices = parseModelPrices({
      model_prices: {
        'un-modelo-nuevo-cualquiera': {
          input_per_million: 1,
          output_per_million: 2,
        },
      },
    });
    expect(prices['un-modelo-nuevo-cualquiera']).toBeDefined();
  });

  it('lanza si un precio es negativo o de tipo incorrecto', () => {
    expect(() =>
      parseModelPrices({
        model_prices: {
          x: { input_per_million: -1, output_per_million: 2 },
        },
      }),
    ).toThrow(/config\/models\.yaml \(model_prices\) inválido/);
    expect(() =>
      parseModelPrices({
        model_prices: { x: { input_per_million: 'gratis' } },
      }),
    ).toThrow();
  });

  it('lanza si falta la clave model_prices por completo', () => {
    expect(() => parseModelPrices({})).toThrow();
  });
});

describe('loadModelPrices', () => {
  it('carga y valida el config/models.yaml real, incluyendo los 9 modelos documentados', () => {
    const realPath = join(process.cwd(), 'config', 'models.yaml');
    const prices = loadModelPrices(realPath);

    expect(prices['claude-opus-4-8']).toEqual({
      inputPerMillion: 15,
      outputPerMillion: 75,
    });
    expect(prices['gemini-3.1-pro']).toEqual({
      inputPerMillion: 1.25,
      outputPerMillion: 10,
    });
    expect(Object.keys(prices)).toHaveLength(9);
  });
});
