import { describe, expect, it } from 'vitest';
import { UnknownTaskProfileError } from './errors';
import type { ModelsConfig } from './model-provider.types';
import { selectModel } from './router.logic';

// Espejo de config/models.yaml (docs/MODEL_ROUTING.md 2.1) — valores
// representativos, no necesita ser byte-a-byte idéntico al YAML real
// para probar la lógica pura del selector.
const PROFILES: ModelsConfig = {
  reasoning_heavy: {
    description: 'Razonamiento complejo, debug, arquitectura',
    primary: 'claude-opus-4-8',
    fallback: 'claude-sonnet-5',
    maxTokensInput: 200_000,
    maxTokensOutput: 8000,
    temperature: 0.3,
  },
  coding_default: {
    description: 'Generación y edición de código diario',
    primary: 'claude-sonnet-5',
    fallback: 'gemini-3.5-flash',
    maxTokensInput: 100_000,
    maxTokensOutput: 4000,
    temperature: 0.2,
  },
  long_context: {
    description: 'Análisis de documentos largos, PDFs, hilos de correo',
    primary: 'gemini-3.1-pro',
    fallback: 'claude-opus-4-8',
    maxTokensInput: 1_500_000,
    maxTokensOutput: 8000,
    temperature: 0.4,
  },
  extraction_fast: {
    description: 'Clasificación, extracción de entidades, resúmenes cortos',
    primary: 'claude-haiku-4-5',
    fallback: 'gemini-2.5-flash-lite',
    maxTokensInput: 32_000,
    maxTokensOutput: 1000,
    temperature: 0.1,
  },
  chat_conversational: {
    description: 'Chat con el usuario, respuestas conversacionales',
    primary: 'claude-sonnet-5',
    fallback: 'claude-haiku-4-5',
    maxTokensInput: 50_000,
    maxTokensOutput: 2000,
    temperature: 0.7,
  },
  code_execution_planner: {
    description: 'Genera código para pods Deno / Modal',
    primary: 'claude-opus-4-8',
    fallback: 'claude-sonnet-5',
    maxTokensInput: 100_000,
    maxTokensOutput: 8000,
    temperature: 0.2,
  },
  memory_consolidation: {
    description: 'Destila la sesión en entradas de memoria (sqlite-vec)',
    primary: 'claude-haiku-4-5',
    fallback: 'gemini-2.5-flash-lite',
    maxTokensInput: 64_000,
    maxTokensOutput: 2000,
    temperature: 0.2,
  },
  history_compaction: {
    description: 'Comprime un tramo viejo del historial de chat',
    primary: 'claude-haiku-4-5',
    fallback: 'gemini-2.5-flash-lite',
    maxTokensInput: 64_000,
    maxTokensOutput: 1000,
    temperature: 0.2,
  },
  vision_analysis: {
    description: 'Análisis de screenshots, imágenes, gráficas',
    primary: 'claude-opus-4-8',
    fallback: 'gemini-3.1-pro',
    maxTokensInput: 100_000,
    maxTokensOutput: 4000,
    temperature: 0.3,
  },
};

describe('selectModel', () => {
  it.each(Object.keys(PROFILES) as (keyof typeof PROFILES)[])(
    '%s sin hints selecciona el primary',
    (taskProfile) => {
      const selected = selectModel(PROFILES, taskProfile);
      expect(selected.tier).toBe('primary');
      expect(selected.modelId).toBe(PROFILES[taskProfile].primary);
    },
  );

  it('lanza UnknownTaskProfileError para un profile que no existe en config/models.yaml', () => {
    let caught: unknown;
    try {
      selectModel(PROFILES, 'no_existe' as never);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnknownTaskProfileError);
    expect((caught as UnknownTaskProfileError).code).toBe(
      'MODEL_PROVIDER_UNKNOWN_TASK_PROFILE',
    );
  });

  it('degrada a fallback cuando estimatedInputTokens supera el límite del primary', () => {
    const selected = selectModel(PROFILES, 'coding_default', {
      estimatedInputTokens: 150_000,
    });
    expect(selected.tier).toBe('fallback');
    expect(selected.modelId).toBe('gemini-3.5-flash');
  });

  it('no degrada cuando estimatedInputTokens entra dentro del límite del primary', () => {
    const selected = selectModel(PROFILES, 'coding_default', {
      estimatedInputTokens: 50_000,
    });
    expect(selected.tier).toBe('primary');
  });

  it('degrada a fallback cuando latencyRequirement es "low"', () => {
    const selected = selectModel(PROFILES, 'reasoning_heavy', {
      latencyRequirement: 'low',
    });
    expect(selected.tier).toBe('fallback');
    expect(selected.modelId).toBe('claude-sonnet-5');
  });

  it('no degrada cuando latencyRequirement es "normal"', () => {
    const selected = selectModel(PROFILES, 'reasoning_heavy', {
      latencyRequirement: 'normal',
    });
    expect(selected.tier).toBe('primary');
  });

  it('degrada a fallback cuando budgetRemaining está por debajo del umbral', () => {
    const selected = selectModel(PROFILES, 'vision_analysis', {
      budgetRemaining: 0.1,
    });
    expect(selected.tier).toBe('fallback');
    expect(selected.modelId).toBe('gemini-3.1-pro');
  });

  it('no degrada cuando budgetRemaining está por encima del umbral', () => {
    const selected = selectModel(PROFILES, 'vision_analysis', {
      budgetRemaining: 0.9,
    });
    expect(selected.tier).toBe('primary');
  });

  it('cualquier hint de degradación es suficiente, aunque los demás no apliquen', () => {
    const selected = selectModel(PROFILES, 'extraction_fast', {
      estimatedInputTokens: 100, // dentro del límite
      latencyRequirement: 'normal', // no degrada
      budgetRemaining: 0.05, // sí degrada
    });
    expect(selected.tier).toBe('fallback');
  });
});
