import { describe, expect, it, vi } from 'vitest';
import type { ModelCompletionRequest } from '../model-provider/model-provider.types';
import type { ModelRouterService } from '../model-provider/router.service';
import { BudgetGuardedModelRouter } from './budget-guarded-router.service';
import type { BudgetService } from './budget.service';
import { KillSwitchActiveError, SessionBudgetExceededError } from './errors';
import type { KillSwitchService } from './kill-switch.service';

const REQUEST: ModelCompletionRequest = {
  messages: [{ role: 'user', content: 'hola' }],
  maxOutputTokens: 100,
  temperature: 0.2,
};

function fakeResponse() {
  return {
    content: 'ok',
    modelId: 'claude-sonnet-5',
    inputTokens: 10,
    outputTokens: 10,
  };
}

describe('BudgetGuardedModelRouter.complete', () => {
  it('lanza KillSwitchActiveError sin siquiera consultar el budget ni el router', async () => {
    const modelRouterComplete = vi.fn();
    const modelRouter = {
      complete: modelRouterComplete,
    } as unknown as ModelRouterService;
    const checkBeforeCall = vi.fn();
    const budgetService = {
      checkBeforeCall,
      recordUsage: vi.fn(),
    } as unknown as BudgetService;
    const killSwitchService = {
      isActive: vi.fn().mockResolvedValue(true),
    } as unknown as KillSwitchService;

    const guarded = new BudgetGuardedModelRouter(
      modelRouter,
      budgetService,
      killSwitchService,
    );

    await expect(
      guarded.complete('chat_conversational', REQUEST),
    ).rejects.toThrow(KillSwitchActiveError);
    expect(checkBeforeCall).not.toHaveBeenCalled();
    expect(modelRouterComplete).not.toHaveBeenCalled();
  });

  it('propaga SessionBudgetExceededError del budget sin llamar al router', async () => {
    const modelRouterComplete = vi.fn();
    const modelRouter = {
      complete: modelRouterComplete,
    } as unknown as ModelRouterService;
    const budgetService = {
      checkBeforeCall: vi
        .fn()
        .mockRejectedValue(new SessionBudgetExceededError('sess-1')),
      recordUsage: vi.fn(),
    } as unknown as BudgetService;
    const killSwitchService = {
      isActive: vi.fn().mockResolvedValue(false),
    } as unknown as KillSwitchService;

    const guarded = new BudgetGuardedModelRouter(
      modelRouter,
      budgetService,
      killSwitchService,
    );

    await expect(
      guarded.complete('chat_conversational', REQUEST),
    ).rejects.toThrow(SessionBudgetExceededError);
    expect(modelRouterComplete).not.toHaveBeenCalled();
  });

  it('inyecta budgetRemaining como hint al llamar a ModelRouterService', async () => {
    const modelRouterComplete = vi.fn().mockResolvedValue(fakeResponse());
    const modelRouter = {
      complete: modelRouterComplete,
    } as unknown as ModelRouterService;
    const budgetService = {
      checkBeforeCall: vi.fn().mockResolvedValue({ budgetRemaining: 0.15 }),
      recordUsage: vi.fn().mockResolvedValue(undefined),
    } as unknown as BudgetService;
    const killSwitchService = {
      isActive: vi.fn().mockResolvedValue(false),
    } as unknown as KillSwitchService;

    const guarded = new BudgetGuardedModelRouter(
      modelRouter,
      budgetService,
      killSwitchService,
    );

    await guarded.complete('chat_conversational', REQUEST);

    expect(modelRouterComplete).toHaveBeenCalledWith(
      'chat_conversational',
      REQUEST,
      expect.objectContaining({ budgetRemaining: 0.15 }),
    );
  });

  it('suma el tamaño serializado de tools al estimado de tokens (Fase 5.1)', async () => {
    const modelRouter = {
      complete: vi.fn().mockResolvedValue(fakeResponse()),
    } as unknown as ModelRouterService;
    const checkBeforeCall = vi.fn().mockResolvedValue({ budgetRemaining: 1 });
    const budgetService = {
      checkBeforeCall,
      recordUsage: vi.fn().mockResolvedValue(undefined),
    } as unknown as BudgetService;
    const killSwitchService = {
      isActive: vi.fn().mockResolvedValue(false),
    } as unknown as KillSwitchService;

    const guarded = new BudgetGuardedModelRouter(
      modelRouter,
      budgetService,
      killSwitchService,
    );

    await guarded.complete('chat_conversational', REQUEST);
    const [{ estimatedInputTokens: withoutTools }] = checkBeforeCall.mock
      .calls[0] as [{ estimatedInputTokens: number }];

    checkBeforeCall.mockClear();
    await guarded.complete('chat_conversational', {
      ...REQUEST,
      tools: [
        {
          name: 'listCalendarEvents',
          description: 'Lista eventos de Google Calendar en un rango de fechas',
          inputSchema: {
            type: 'object',
            properties: { maxResults: { type: 'number' } },
          },
        },
      ],
    });
    const [{ estimatedInputTokens: withTools }] = checkBeforeCall.mock
      .calls[0] as [{ estimatedInputTokens: number }];

    expect(withTools).toBeGreaterThan(withoutTools);
  });

  it('registra el uso real (tokens de la respuesta, no la estimación) tras una llamada exitosa', async () => {
    const modelRouter = {
      complete: vi.fn().mockResolvedValue(fakeResponse()),
    } as unknown as ModelRouterService;
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const budgetService = {
      checkBeforeCall: vi.fn().mockResolvedValue({ budgetRemaining: 1 }),
      recordUsage,
    } as unknown as BudgetService;
    const killSwitchService = {
      isActive: vi.fn().mockResolvedValue(false),
    } as unknown as KillSwitchService;

    const guarded = new BudgetGuardedModelRouter(
      modelRouter,
      budgetService,
      killSwitchService,
    );

    await guarded.complete('chat_conversational', REQUEST);

    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'claude-sonnet-5',
        inputTokens: 10,
        outputTokens: 10,
      }),
    );
  });

  it('sin sessionId, genera uno nuevo por llamada — dos llamadas sin sessionId no comparten sesión', async () => {
    const modelRouter = {
      complete: vi.fn().mockResolvedValue(fakeResponse()),
    } as unknown as ModelRouterService;
    const checkBeforeCall = vi.fn().mockResolvedValue({ budgetRemaining: 1 });
    const budgetService = {
      checkBeforeCall,
      recordUsage: vi.fn().mockResolvedValue(undefined),
    } as unknown as BudgetService;
    const killSwitchService = {
      isActive: vi.fn().mockResolvedValue(false),
    } as unknown as KillSwitchService;

    const guarded = new BudgetGuardedModelRouter(
      modelRouter,
      budgetService,
      killSwitchService,
    );

    await guarded.complete('chat_conversational', REQUEST);
    await guarded.complete('chat_conversational', REQUEST);

    const [firstCallSessionId] = checkBeforeCall.mock.calls[0] as [
      { sessionId: string },
    ];
    const [secondCallSessionId] = checkBeforeCall.mock.calls[1] as [
      { sessionId: string },
    ];
    expect(firstCallSessionId.sessionId).not.toBe(
      secondCallSessionId.sessionId,
    );
  });

  it('con sessionId explícito, lo reusa (misma sesión entre llamadas)', async () => {
    const modelRouter = {
      complete: vi.fn().mockResolvedValue(fakeResponse()),
    } as unknown as ModelRouterService;
    const checkBeforeCall = vi.fn().mockResolvedValue({ budgetRemaining: 1 });
    const budgetService = {
      checkBeforeCall,
      recordUsage: vi.fn().mockResolvedValue(undefined),
    } as unknown as BudgetService;
    const killSwitchService = {
      isActive: vi.fn().mockResolvedValue(false),
    } as unknown as KillSwitchService;

    const guarded = new BudgetGuardedModelRouter(
      modelRouter,
      budgetService,
      killSwitchService,
    );

    await guarded.complete(
      'chat_conversational',
      REQUEST,
      undefined,
      'sess-fixed',
    );

    expect(checkBeforeCall).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-fixed' }),
    );
  });
});

describe('BudgetGuardedModelRouter.completeStream', () => {
  it('hace checkBeforeCall/recordUsage igual que complete(), reenviando los deltas del router', async () => {
    const onDeltaFromCaller = vi.fn();
    const modelRouterCompleteStream = vi
      .fn()
      .mockImplementation(
        (
          _taskProfile: string,
          _request: ModelCompletionRequest,
          onDelta: (d: string, s: string) => void,
        ) => {
          onDelta('Hola', 'Hola');
          return fakeResponse();
        },
      );
    const modelRouter = {
      completeStream: modelRouterCompleteStream,
    } as unknown as ModelRouterService;
    const checkBeforeCall = vi.fn().mockResolvedValue({ budgetRemaining: 1 });
    const recordUsage = vi.fn().mockResolvedValue(undefined);
    const budgetService = {
      checkBeforeCall,
      recordUsage,
    } as unknown as BudgetService;
    const killSwitchService = {
      isActive: vi.fn().mockResolvedValue(false),
    } as unknown as KillSwitchService;

    const guarded = new BudgetGuardedModelRouter(
      modelRouter,
      budgetService,
      killSwitchService,
    );

    const result = await guarded.completeStream(
      'chat_conversational',
      REQUEST,
      onDeltaFromCaller,
    );

    expect(checkBeforeCall).toHaveBeenCalledTimes(1);
    expect(onDeltaFromCaller).toHaveBeenCalledWith('Hola', 'Hola');
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'claude-sonnet-5',
        inputTokens: 10,
        outputTokens: 10,
      }),
    );
    expect(result).toEqual(fakeResponse());
  });

  it('lanza KillSwitchActiveError sin consultar el budget ni el router', async () => {
    const modelRouterCompleteStream = vi.fn();
    const modelRouter = {
      completeStream: modelRouterCompleteStream,
    } as unknown as ModelRouterService;
    const checkBeforeCall = vi.fn();
    const budgetService = {
      checkBeforeCall,
      recordUsage: vi.fn(),
    } as unknown as BudgetService;
    const killSwitchService = {
      isActive: vi.fn().mockResolvedValue(true),
    } as unknown as KillSwitchService;

    const guarded = new BudgetGuardedModelRouter(
      modelRouter,
      budgetService,
      killSwitchService,
    );

    await expect(
      guarded.completeStream('chat_conversational', REQUEST, vi.fn()),
    ).rejects.toThrow(KillSwitchActiveError);
    expect(checkBeforeCall).not.toHaveBeenCalled();
    expect(modelRouterCompleteStream).not.toHaveBeenCalled();
  });

  it('si modelRouter.completeStream rechaza (ej. StreamAlreadyPartiallyEmittedError), recordUsage NO se llama', async () => {
    const modelRouter = {
      completeStream: vi
        .fn()
        .mockRejectedValue(new Error('stream interrumpido')),
    } as unknown as ModelRouterService;
    const recordUsage = vi.fn();
    const budgetService = {
      checkBeforeCall: vi.fn().mockResolvedValue({ budgetRemaining: 1 }),
      recordUsage,
    } as unknown as BudgetService;
    const killSwitchService = {
      isActive: vi.fn().mockResolvedValue(false),
    } as unknown as KillSwitchService;

    const guarded = new BudgetGuardedModelRouter(
      modelRouter,
      budgetService,
      killSwitchService,
    );

    await expect(
      guarded.completeStream('chat_conversational', REQUEST, vi.fn()),
    ).rejects.toThrow('stream interrumpido');
    expect(recordUsage).not.toHaveBeenCalled();
  });
});
