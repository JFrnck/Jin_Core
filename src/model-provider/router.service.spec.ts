import { describe, expect, it, vi } from 'vitest';
import type { AnthropicProvider } from './anthropic.provider';
import type { ChatModelPreferenceService } from './chat-model-preference.service';
import { UnknownModelVendorError } from './errors';
import type { FailoverService } from './failover.service';
import type { GoogleProvider } from './google.provider';
import type {
  ModelCompletionRequest,
  ModelCompletionResponse,
  ModelsConfig,
} from './model-provider.types';
import type { OpenAIProvider } from './openai.provider';
import { ModelRouterService } from './router.service';
import type { FeatureFlagsService } from '../feature-flags/feature-flags.service';

// Fase 9.5: sin override -- estos tests no ejercitan feature flags.
const NO_OP_FEATURE_FLAGS = {
  getModelOverride: () => undefined,
} as unknown as FeatureFlagsService;

// Este spec no ejercita OpenAI ni la preferencia de chat del owner.
const NO_OP_OPENAI = {} as unknown as OpenAIProvider;
const NO_OP_CHAT_PREFERENCE = {
  getPreference: () => null,
} as unknown as ChatModelPreferenceService;

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
      NO_OP_OPENAI,
      failoverService,
      NO_OP_FEATURE_FLAGS,
      NO_OP_CHAT_PREFERENCE,
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
      NO_OP_OPENAI,
      failoverService,
      NO_OP_FEATURE_FLAGS,
      NO_OP_CHAT_PREFERENCE,
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
      NO_OP_OPENAI,
      failoverService,
      NO_OP_FEATURE_FLAGS,
      NO_OP_CHAT_PREFERENCE,
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
      NO_OP_OPENAI,
      failoverService,
      NO_OP_FEATURE_FLAGS,
      NO_OP_CHAT_PREFERENCE,
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
      NO_OP_OPENAI,
      failoverService,
      NO_OP_FEATURE_FLAGS,
      NO_OP_CHAT_PREFERENCE,
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

describe('ModelRouterService.completeStream', () => {
  it('delega a AnthropicProvider.completeStream cuando el provider lo soporta', async () => {
    const onDeltaFromProvider = vi.fn();
    const anthropicCompleteStream = vi
      .fn()
      .mockImplementation(
        (
          _modelId: string,
          _request: ModelCompletionRequest,
          onDelta: (d: string, s: string) => void,
        ) => {
          onDelta('Hola', 'Hola');
          return fakeResponse('claude-sonnet-5');
        },
      );
    const anthropicProvider = {
      complete: vi.fn(),
      completeStream: anthropicCompleteStream,
    } as unknown as AnthropicProvider;
    const googleProvider = { complete: vi.fn() } as unknown as GoogleProvider;
    const failoverService = {
      executeWithFailoverStream: vi.fn(
        (
          _context,
          callPrimary: (onDelta: (d: string, s: string) => void) => unknown,
        ) => callPrimary(onDeltaFromProvider),
      ),
    } as unknown as FailoverService;

    const router = new ModelRouterService(
      PROFILES,
      anthropicProvider,
      googleProvider,
      NO_OP_OPENAI,
      failoverService,
      NO_OP_FEATURE_FLAGS,
      NO_OP_CHAT_PREFERENCE,
    );

    const result = await router.completeStream(
      'coding_default',
      REQUEST,
      vi.fn(),
    );

    expect(result.modelId).toBe('claude-sonnet-5');
    expect(anthropicCompleteStream).toHaveBeenCalledWith(
      'claude-sonnet-5',
      REQUEST,
      onDeltaFromProvider,
    );
    expect(onDeltaFromProvider).toHaveBeenCalledWith('Hola', 'Hola');
  });

  it('degrada a complete() + un único delta con el contenido completo cuando el provider NO soporta completeStream (hoy, Google)', async () => {
    const onDeltaFromProvider = vi.fn();
    const googleComplete = vi.fn().mockResolvedValue({
      content: 'respuesta completa de Gemini',
      modelId: 'gemini-3.1-pro',
      inputTokens: 4,
      outputTokens: 6,
      stopReason: 'end_turn' as const,
    });
    const googleProvider = {
      complete: googleComplete,
      // Sin `completeStream` — GoogleProvider no lo implementa hoy.
    } as unknown as GoogleProvider;
    const anthropicProvider = {
      complete: vi.fn(),
    } as unknown as AnthropicProvider;
    const failoverService = {
      executeWithFailoverStream: vi.fn(
        (
          _context,
          callPrimary: (onDelta: (d: string, s: string) => void) => unknown,
        ) => callPrimary(onDeltaFromProvider),
      ),
    } as unknown as FailoverService;

    const router = new ModelRouterService(
      PROFILES,
      anthropicProvider,
      googleProvider,
      NO_OP_OPENAI,
      failoverService,
      NO_OP_FEATURE_FLAGS,
      NO_OP_CHAT_PREFERENCE,
    );

    const result = await router.completeStream(
      'long_context',
      REQUEST,
      vi.fn(),
    );

    expect(result.modelId).toBe('gemini-3.1-pro');
    expect(googleComplete).toHaveBeenCalledWith('gemini-3.1-pro', REQUEST);
    expect(onDeltaFromProvider).toHaveBeenCalledTimes(1);
    expect(onDeltaFromProvider).toHaveBeenCalledWith(
      'respuesta completa de Gemini',
      'respuesta completa de Gemini',
    );
  });
});

describe('ModelRouterService: preferencia de modelo del owner (2026-09-28)', () => {
  function routerWith(
    chatModelPreferenceService: unknown,
    overrides: {
      openaiComplete?: ReturnType<typeof vi.fn>;
      anthropicComplete?: ReturnType<typeof vi.fn>;
    } = {},
  ) {
    const anthropicComplete =
      overrides.anthropicComplete ??
      vi.fn((modelId: string) => Promise.resolve(fakeResponse(modelId)));
    const anthropicProvider = {
      complete: anthropicComplete,
    } as unknown as AnthropicProvider;
    const googleProvider = { complete: vi.fn() } as unknown as GoogleProvider;
    const openaiComplete =
      overrides.openaiComplete ??
      vi.fn((modelId: string) => Promise.resolve(fakeResponse(modelId)));
    const openaiProvider = {
      complete: openaiComplete,
    } as unknown as OpenAIProvider;
    const failoverService = {
      executeWithFailover: vi.fn((_context, callPrimary: () => unknown) =>
        callPrimary(),
      ),
    } as unknown as FailoverService;

    const router = new ModelRouterService(
      PROFILES,
      anthropicProvider,
      googleProvider,
      openaiProvider,
      failoverService,
      NO_OP_FEATURE_FLAGS,
      chatModelPreferenceService as ChatModelPreferenceService,
    );
    return { router, anthropicComplete, openaiComplete };
  }

  it('sin preferencia (null): chat_conversational usa el primary de siempre, sin effort en la request', async () => {
    const { router, anthropicComplete } = routerWith({
      getPreference: () => null,
    });
    await router.complete('chat_conversational', REQUEST);
    expect(anthropicComplete).toHaveBeenCalledWith('claude-sonnet-5', REQUEST);
  });

  it('con preferencia: chat_conversational despacha al vendor/modelo elegido, con el effort mezclado en la request', async () => {
    const { router, openaiComplete } = routerWith({
      getPreference: () => ({
        vendor: 'openai',
        modelId: 'gpt-5.1',
        effort: 'high',
        setBy: 'owner:api',
        changedAt: '2026-09-28T00:00:00.000Z',
      }),
    });

    const result = await router.complete('chat_conversational', REQUEST);

    expect(result.modelId).toBe('gpt-5.1');
    expect(openaiComplete).toHaveBeenCalledWith('gpt-5.1', {
      ...REQUEST,
      effort: 'high',
    });
  });

  it('la preferencia del owner NUNCA afecta a otro TaskProfile (solo chat_conversational puede elegirse)', async () => {
    const getPreference = vi.fn().mockReturnValue({
      vendor: 'openai',
      modelId: 'gpt-5.1',
      effort: 'high',
      setBy: 'owner:api',
      changedAt: '2026-09-28T00:00:00.000Z',
    });
    const { router, anthropicComplete } = routerWith({ getPreference });

    const result = await router.complete('reasoning_heavy', REQUEST);

    // reasoning_heavy.primary sigue siendo claude-opus-4-8: la preferencia no se consultó.
    expect(result.modelId).toBe('claude-opus-4-8');
    expect(anthropicComplete).toHaveBeenCalledWith('claude-opus-4-8', REQUEST);
    expect(getPreference).not.toHaveBeenCalled();
  });

  it('effort ausente en la preferencia (modelo sin esfuerzo elegido): la request no lleva effort', async () => {
    const { router, anthropicComplete } = routerWith({
      getPreference: () => ({
        vendor: 'anthropic',
        modelId: 'claude-haiku-4-5',
        effort: null,
        setBy: 'owner:api',
        changedAt: '2026-09-28T00:00:00.000Z',
      }),
    });

    await router.complete('chat_conversational', REQUEST);

    const sent = anthropicComplete.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(sent).not.toHaveProperty('effort');
  });
});
