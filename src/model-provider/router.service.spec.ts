import { describe, expect, it, vi } from 'vitest';
import type { AnthropicProvider } from './anthropic.provider';
import { UnknownModelVendorError } from './errors';
import type { FailoverService } from './failover.service';
import type { GoogleProvider } from './google.provider';
import type {
  ModelCompletionRequest,
  ModelCompletionResponse,
  ModelsConfig,
} from './model-provider.types';
import { ModelRouterService } from './router.service';
import type { FeatureFlagsService } from '../feature-flags/feature-flags.service';

// Fase 9.5: sin override -- estos tests no ejercitan feature flags.
const NO_OP_FEATURE_FLAGS = {
  getModelOverride: () => undefined,
} as unknown as FeatureFlagsService;

const REQUEST: ModelCompletionRequest = {
  messages: [{ role: 'user', content: 'hola' }],
  maxOutputTokens: 100,
  temperature: 0.2,
};

const PROFILES: ModelsConfig = {
  reasoning_heavy: {
    description: 'x',
    primary: 'claude-opus-4-8',
    fallback: 'claude-sonnet-5',
    maxTokensInput: 200_000,
    maxTokensOutput: 8000,
    temperature: 0.3,
  },
  coding_default: {
    description: 'x',
    primary: 'claude-sonnet-5',
    fallback: 'gemini-3.5-flash',
    maxTokensInput: 100_000,
    maxTokensOutput: 4000,
    temperature: 0.2,
  },
  long_context: {
    description: 'x',
    primary: 'gemini-3.1-pro',
    fallback: 'claude-opus-4-8',
    maxTokensInput: 1_500_000,
    maxTokensOutput: 8000,
    temperature: 0.4,
  },
  extraction_fast: {
    description: 'x',
    primary: 'claude-haiku-4-5',
    fallback: 'gemini-2.5-flash-lite',
    maxTokensInput: 32_000,
    maxTokensOutput: 1000,
    temperature: 0.1,
  },
  chat_conversational: {
    description: 'x',
    primary: 'claude-sonnet-5',
    fallback: 'claude-haiku-4-5',
    maxTokensInput: 50_000,
    maxTokensOutput: 2000,
    temperature: 0.7,
  },
  code_execution_planner: {
    description: 'x',
    primary: 'claude-opus-4-8',
    fallback: 'claude-sonnet-5',
    maxTokensInput: 100_000,
    maxTokensOutput: 8000,
    temperature: 0.2,
  },
  memory_consolidation: {
    description: 'x',
    primary: 'claude-haiku-4-5',
    fallback: 'gemini-2.5-flash-lite',
    maxTokensInput: 64_000,
    maxTokensOutput: 2000,
    temperature: 0.2,
  },
  history_compaction: {
    description: 'x',
    primary: 'claude-haiku-4-5',
    fallback: 'gemini-2.5-flash-lite',
    maxTokensInput: 64_000,
    maxTokensOutput: 1000,
    temperature: 0.2,
  },
  vision_analysis: {
    description: 'x',
    // Modelo con vendor deliberadamente desconocido, para probar
    // UnknownModelVendorError sin inventar un noveno profile.
    primary: 'mystery-vendor-model-1',
    fallback: 'gemini-3.1-pro',
    maxTokensInput: 100_000,
    maxTokensOutput: 4000,
    temperature: 0.3,
  },
};

function fakeResponse(modelId: string): ModelCompletionResponse {
  return {
    content: 'ok',
    modelId,
    inputTokens: 1,
    outputTokens: 1,
    stopReason: 'end_turn',
  };
}

describe('ModelRouterService.complete', () => {
  it('despacha al provider de Anthropic cuando el modelo elegido empieza con "claude-"', async () => {
    const anthropicComplete = vi
      .fn()
      .mockResolvedValue(fakeResponse('claude-sonnet-5'));
    const anthropicProvider = {
      complete: anthropicComplete,
    } as unknown as AnthropicProvider;
    const googleComplete = vi.fn();
    const googleProvider = {
      complete: googleComplete,
    } as unknown as GoogleProvider;
    const failoverService = {
      executeWithFailover: vi.fn((_context, callPrimary: () => unknown) =>
        callPrimary(),
      ),
    } as unknown as FailoverService;

    const router = new ModelRouterService(
      PROFILES,
      anthropicProvider,
      googleProvider,
      failoverService,
      NO_OP_FEATURE_FLAGS,
    );

    const result = await router.complete('coding_default', REQUEST);

    expect(result.modelId).toBe('claude-sonnet-5');
    expect(anthropicComplete).toHaveBeenCalledWith('claude-sonnet-5', REQUEST);
    expect(googleComplete).not.toHaveBeenCalled();
  });

  it('despacha al provider de Google cuando el modelo elegido empieza con "gemini-"', async () => {
    const googleComplete = vi
      .fn()
      .mockResolvedValue(fakeResponse('gemini-3.1-pro'));
    const googleProvider = {
      complete: googleComplete,
    } as unknown as GoogleProvider;
    const anthropicProvider = {
      complete: vi.fn(),
    } as unknown as AnthropicProvider;
    const failoverService = {
      executeWithFailover: vi.fn((_context, callPrimary: () => unknown) =>
        callPrimary(),
      ),
    } as unknown as FailoverService;

    const router = new ModelRouterService(
      PROFILES,
      anthropicProvider,
      googleProvider,
      failoverService,
      NO_OP_FEATURE_FLAGS,
    );

    const result = await router.complete('long_context', REQUEST);

    expect(result.modelId).toBe('gemini-3.1-pro');
    expect(googleComplete).toHaveBeenCalledWith('gemini-3.1-pro', REQUEST);
  });

  it('en un failover cruzado, el fallback se despacha al vendor correcto aunque sea distinto al del primary', async () => {
    const anthropicComplete = vi.fn();
    const googleComplete = vi
      .fn()
      .mockResolvedValue(fakeResponse('gemini-3.5-flash'));
    const anthropicProvider = {
      complete: anthropicComplete,
    } as unknown as AnthropicProvider;
    const googleProvider = {
      complete: googleComplete,
    } as unknown as GoogleProvider;
    // Simula que el primary (claude-sonnet-5) falló y el orquestador de
    // failover ya decidió llamar al fallback (gemini-3.5-flash).
    const failoverService = {
      executeWithFailover: vi.fn(
        (_context, _callPrimary: () => unknown, callFallback: () => unknown) =>
          callFallback(),
      ),
    } as unknown as FailoverService;

    const router = new ModelRouterService(
      PROFILES,
      anthropicProvider,
      googleProvider,
      failoverService,
      NO_OP_FEATURE_FLAGS,
    );

    const result = await router.complete('coding_default', REQUEST);

    expect(result.modelId).toBe('gemini-3.5-flash');
    expect(googleComplete).toHaveBeenCalledWith('gemini-3.5-flash', REQUEST);
    expect(anthropicComplete).not.toHaveBeenCalled();
  });

  it('pasa estimatedInputTokens como hint para degradar a fallback antes de llamar a ningún provider', async () => {
    const googleComplete = vi
      .fn()
      .mockResolvedValue(fakeResponse('gemini-3.5-flash'));
    const anthropicProvider = {
      complete: vi.fn(),
    } as unknown as AnthropicProvider;
    const googleProvider = {
      complete: googleComplete,
    } as unknown as GoogleProvider;
    const failoverService = {
      executeWithFailover: vi.fn((_context, callPrimary: () => unknown) =>
        callPrimary(),
      ),
    } as unknown as FailoverService;

    const router = new ModelRouterService(
      PROFILES,
      anthropicProvider,
      googleProvider,
      failoverService,
      NO_OP_FEATURE_FLAGS,
    );

    const result = await router.complete('coding_default', REQUEST, {
      estimatedInputTokens: 999_999,
    });

    expect(result.modelId).toBe('gemini-3.5-flash');
  });

  it('lanza UnknownModelVendorError si el modelId no matchea ningún prefijo de vendor conocido', async () => {
    const anthropicProvider = {
      complete: vi.fn(),
    } as unknown as AnthropicProvider;
    const googleProvider = { complete: vi.fn() } as unknown as GoogleProvider;
    const failoverService = {
      executeWithFailover: vi.fn((_context, callPrimary: () => unknown) =>
        callPrimary(),
      ),
    } as unknown as FailoverService;

    const router = new ModelRouterService(
      PROFILES,
      anthropicProvider,
      googleProvider,
      failoverService,
      NO_OP_FEATURE_FLAGS,
    );

    let caught: unknown;
    try {
      await router.complete('vision_analysis', REQUEST);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UnknownModelVendorError);
    expect((caught as UnknownModelVendorError).code).toBe(
      'MODEL_PROVIDER_UNKNOWN_VENDOR',
    );
  });
});
