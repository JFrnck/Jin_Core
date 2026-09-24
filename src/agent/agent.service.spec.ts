import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { BudgetGuardedModelRouter } from '../budget/budget-guarded-router.service';
import type { AutonomyService } from '../autonomy/autonomy.service';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import { HitlPolicyService } from '../hitl-policy/hitl-policy.service';
import { HITL_ACTION_NOTIFIED_EVENT } from '../hitl/notify.events';
import type { HitlDecision } from '../hitl/types';
import { DualConfirmService } from '../hitl/dual-confirm.service';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import type {
  ModelCompletionRequest,
  ModelCompletionResponse,
  ModelMessageContentBlock,
} from '../model-provider/model-provider.types';
import type { AgentConfig } from './agent-config.schema';
import { AgentService } from './agent.service';
import type { HistoryCompactionService } from './history-compaction.service';

function getRequestArg(
  mock: ReturnType<typeof vi.fn>,
  callIndex: number,
): ModelCompletionRequest {
  return (
    mock.mock.calls[callIndex] as unknown as [string, ModelCompletionRequest]
  )[1];
}

/** El último mensaje de una request, como array de bloques (nunca string en estos tests). */
function lastMessageBlocks(
  request: ModelCompletionRequest,
): readonly ModelMessageContentBlock[] {
  const content = request.messages.at(-1)?.content;
  if (!content || typeof content === 'string') {
    throw new Error('Se esperaba contenido en bloques, no string.');
  }
  return content;
}

function fakeResponse(
  overrides: Partial<ModelCompletionResponse>,
): ModelCompletionResponse {
  return {
    content: '',
    modelId: 'claude-sonnet-5',
    inputTokens: 10,
    outputTokens: 10,
    stopReason: 'end_turn',
    ...overrides,
  };
}

describe('AgentService.runTurn', () => {
  let completeMock: ReturnType<typeof vi.fn>;
  let mockRouter: { complete: ReturnType<typeof vi.fn> };
  let toolExecutorRegistry: ToolExecutorRegistry;
  let mockDualConfirm: Partial<DualConfirmService>;
  let mockAuditService: Partial<AuditService>;
  let mockHistoryCompactionService: Partial<HistoryCompactionService>;
  let mockFeatureFlagsService: Partial<FeatureFlagsService>;
  let mockAutonomyService: { relax: ReturnType<typeof vi.fn> };
  let mockEmit: ReturnType<typeof vi.fn>;
  let hitlPolicyService: HitlPolicyService;
  let config: AgentConfig;
  let service: AgentService;

  beforeEach(() => {
    completeMock = vi.fn();
    mockRouter = { complete: completeMock };
    toolExecutorRegistry = new ToolExecutorRegistry();
    mockDualConfirm = {
      createPendingApproval: vi.fn().mockResolvedValue(undefined),
    };
    mockAuditService = {
      recordToolCall: vi.fn().mockResolvedValue(undefined),
    };
    mockHistoryCompactionService = {
      compact: vi.fn(),
    };
    // Fase 9.5: por default ninguna integración está apagada, y el
    // override de hitlLevel nunca cambia nada -- los tests que sí
    // quieren ejercitar feature flags lo overridean puntualmente.
    mockFeatureFlagsService = {
      isIntegrationEnabled: vi.fn().mockReturnValue(true),
      resolveEffectiveLevel: vi
        .fn()
        .mockImplementation((decision) => Promise.resolve(decision)),
    };
    // ADR 0010: modo `supervised` por default (relax = identidad); los tests
    // de modos de autonomía viven en autonomy.service.spec.ts y en el golden set.
    mockAutonomyService = {
      relax: vi
        .fn()
        .mockImplementation((decision) => Promise.resolve(decision)),
    };
    mockEmit = vi.fn();
    hitlPolicyService = new HitlPolicyService(
      mockFeatureFlagsService as FeatureFlagsService,
      mockAutonomyService as unknown as AutonomyService,
    );
    config = {
      maxIterationsPerTurn: 5,
      maxConsecutiveToolFailures: 2,
      maxConcurrentSubAgents: 3,
      // Alto a propósito: la mayoría de los casos de este archivo no
      // ejercitan la compresión — los que sí, la overridean puntualmente.
      maxHistoryTokens: 1_000_000,
      preserveLastTurns: 6,
    };

    service = new AgentService(
      mockRouter as unknown as BudgetGuardedModelRouter,
      toolExecutorRegistry,
      mockDualConfirm as DualConfirmService,
      mockAuditService as AuditService,
      mockHistoryCompactionService as HistoryCompactionService,
      mockFeatureFlagsService as FeatureFlagsService,
      hitlPolicyService,
      { emit: mockEmit } as unknown as EventEmitter2,
      config,
    );
  });

  it('termina el turno de inmediato si la primera respuesta no pide ninguna tool', async () => {
    completeMock.mockResolvedValue(
      fakeResponse({ content: 'hola, ¿en qué te ayudo?' }),
    );

    const result = await service.runTurn({
      sessionId: 'sess-1',
      objective: 'hola',
    });

    expect(result).toEqual({
      finalResponse: 'hola, ¿en qué te ayudo?',
      plan: { steps: [] },
      pendingApprovals: [],
      iterationsUsed: 1,
      modelsUsed: ['claude-sonnet-5'],
    });
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  it('stopReason "refusal" (clasificador de seguridad de Anthropic): nunca reenvía un finalResponse vacío al owner', async () => {
    completeMock.mockResolvedValue(
      fakeResponse({ content: '', stopReason: 'refusal' }),
    );

    const result = await service.runTurn({
      sessionId: 'sess-1',
      objective: 'levantá una app con vite, react y tailwind',
    });

    expect(result.finalResponse).not.toBe('');
    expect(result.finalResponse.toLowerCase()).toContain('no pude generar');
  });

  it('content vacío sin ser un refusal explícito: mismo mensaje de fallback (nunca un mensaje en blanco)', async () => {
    completeMock.mockResolvedValue(
      fakeResponse({ content: '', stopReason: 'end_turn' }),
    );

    const result = await service.runTurn({
      sessionId: 'sess-1',
      objective: 'hola',
    });

    expect(result.finalResponse).not.toBe('');
  });

  it('modelsUsed lista los modelos que respondieron, sin repetir y en orden (visible si hubo fallback)', async () => {
    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          content: '',
          stopReason: 'tool_use',
          toolCalls: [
            { id: 't1', name: 'searchCorpus', input: { query: 'x' } },
          ],
          modelId: 'claude-sonnet-5',
        }),
      )
      .mockResolvedValueOnce(
        fakeResponse({
          content: 'listo',
          modelId: 'claude-haiku-4-5-20251001',
        }),
      );

    const result = await service.runTurn({
      sessionId: 'sess-1',
      objective: 'busca x',
    });

    expect(result.modelsUsed).toEqual([
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('propaga sessionId a cada llamada de BudgetGuardedModelRouter', async () => {
    completeMock.mockResolvedValue(fakeResponse({ content: 'ok' }));

    await service.runTurn({ sessionId: 'sess-42', objective: 'hola' });

    expect(completeMock).toHaveBeenCalledWith(
      'chat_conversational',
      expect.anything(),
      undefined,
      'sess-42',
    );
  });

  it('sin allowedTools: declara TODAS las tools registradas (comportamiento anterior a Fase 5.4, intacto)', async () => {
    completeMock.mockResolvedValue(fakeResponse({ content: 'ok' }));

    await service.runTurn({ sessionId: 'sess-1', objective: 'hola' });

    const request = getRequestArg(completeMock, 0);
    const toolNames = request.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain('declarePlan');
    expect(toolNames).toContain('updatePlanStep');
    expect(toolNames).toContain('readEmails');
    expect(toolNames.length).toBeGreaterThan(3);
  });

  it('con allowedTools: solo declara el subset pedido (más las meta-tools de plan, siempre presentes)', async () => {
    completeMock.mockResolvedValue(fakeResponse({ content: 'ok' }));

    await service.runTurn({
      sessionId: 'sess-1',
      objective: 'hola',
      allowedTools: ['readEmails'],
    });

    const request = getRequestArg(completeMock, 0);
    const toolNames = request.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toEqual(['declarePlan', 'updatePlanStep', 'readEmails']);
  });

  it('declarePlan: registra el plan y sigue el loop hasta la respuesta final', async () => {
    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [
            {
              id: 'call-1',
              name: 'declarePlan',
              input: { steps: ['buscar el evento', 'borrarlo'] },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ content: 'listo' }));

    const result = await service.runTurn({
      sessionId: 'sess-1',
      objective: 'borra mi evento de mañana',
    });

    expect(result.plan).toEqual({
      steps: [
        { description: 'buscar el evento', status: 'pending' },
        { description: 'borrarlo', status: 'pending' },
      ],
    });
    expect(result.finalResponse).toBe('listo');
    expect(result.iterationsUsed).toBe(2);
  });

  it('declarePlan con input inválido (falta "steps"): no crashea, vuelve tool_result de error y plan vacío', async () => {
    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [{ id: 'call-1', name: 'declarePlan', input: {} }],
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ content: 'ok' }));

    const result = await service.runTurn({
      sessionId: 'sess-1',
      objective: 'algo',
    });

    expect(result.plan).toEqual({ steps: [] });
    const blocks = lastMessageBlocks(getRequestArg(completeMock, 1));
    expect(blocks[0]).toEqual(
      expect.objectContaining({ type: 'tool_result', isError: true }),
    );
  });

  it('updatePlanStep con input inválido (status fuera del enum): no crashea, vuelve tool_result de error', async () => {
    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [
            {
              id: 'call-1',
              name: 'updatePlanStep',
              input: { stepIndex: 0, status: 'terminado-total' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ content: 'ok' }));

    const result = await service.runTurn({
      sessionId: 'sess-1',
      objective: 'algo',
    });

    expect(result.finalResponse).toBe('ok');
    const blocks = lastMessageBlocks(getRequestArg(completeMock, 1));
    expect(blocks[0]).toEqual(
      expect.objectContaining({ type: 'tool_result', isError: true }),
    );
  });

  it('updatePlanStep con índice inválido no crashea el loop — vuelve un tool_result de error', async () => {
    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [
            {
              id: 'call-1',
              name: 'updatePlanStep',
              input: { stepIndex: 99, status: 'done' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ content: 'segui igual' }));

    const result = await service.runTurn({
      sessionId: 'sess-1',
      objective: 'algo',
    });

    expect(result.finalResponse).toBe('segui igual');
    // El segundo mensaje enviado al modelo contiene el tool_result de error.
    const blocks = lastMessageBlocks(getRequestArg(completeMock, 1));
    expect(blocks[0]).toEqual(
      expect.objectContaining({ type: 'tool_result', isError: true }),
    );
  });

  it('tool auto: ejecuta ya, audita approvalStatus auto, y el resultado vuelve sanitizado', async () => {
    const executor = vi.fn().mockResolvedValue({ events: ['evt-1'] });
    toolExecutorRegistry.register('listCalendarEvents', executor);

    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [{ id: 'call-1', name: 'listCalendarEvents', input: {} }],
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ content: 'tenés 1 evento' }));

    await service.runTurn({
      sessionId: 'sess-1',
      objective: 'lista mis eventos',
    });

    expect(executor).toHaveBeenCalledWith({});
    expect(mockAuditService.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'listCalendarEvents',
        actor: 'agent',
        approvalStatus: 'auto',
      }),
    );

    const block = lastMessageBlocks(getRequestArg(completeMock, 1))[0];
    const toolResult = block?.type === 'tool_result' ? block : undefined;
    expect(toolResult?.output).toMatch(
      /^<untrusted_content_[0-9a-f]{16} source="listCalendarEvents">/,
    );
    expect(toolResult?.output).toContain('evt-1');
  });

  it('con actorLabel: se usa en vez de "agent" en el audit log (atribución multi-agente, Fase 5.4)', async () => {
    const executor = vi.fn().mockResolvedValue({ events: [] });
    toolExecutorRegistry.register('listCalendarEvents', executor);

    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [{ id: 'call-1', name: 'listCalendarEvents', input: {} }],
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ content: 'listo' }));

    await service.runTurn({
      sessionId: 'sess-1:ticket-abc',
      objective: 'lista mis eventos',
      actorLabel: 'agent:ticket-abc',
    });

    expect(mockAuditService.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'agent:ticket-abc' }),
    );
  });

  it('tool notify: ejecuta ya y audita approvalStatus notified', async () => {
    const executor = vi.fn().mockResolvedValue({ id: 'evt-new' });
    toolExecutorRegistry.register('createCalendarEvent', executor);

    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [
            {
              id: 'call-1',
              name: 'createCalendarEvent',
              input: {
                summary: 'reunión',
                start: '2026-08-01T10:00:00Z',
                end: '2026-08-01T11:00:00Z',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ content: 'evento creado' }));

    await service.runTurn({
      sessionId: 'sess-1',
      objective: 'crea una reunión',
    });

    expect(executor).toHaveBeenCalled();
    expect(mockAuditService.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ approvalStatus: 'notified' }),
    );
  });

  it('tool notify: emite la notificación POST-HOC real (antes solo dejaba la fila del audit y nadie avisaba)', async () => {
    toolExecutorRegistry.register(
      'createCalendarEvent',
      vi.fn().mockResolvedValue({ id: 'e' }),
    );
    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [
            {
              id: 'c1',
              name: 'createCalendarEvent',
              input: { summary: 'x', start: 'a', end: 'b' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ content: 'ok' }));

    await service.runTurn({ sessionId: 's', objective: 'x' });

    expect(mockEmit).toHaveBeenCalledWith(
      HITL_ACTION_NOTIFIED_EVENT,
      expect.objectContaining({
        toolName: 'createCalendarEvent',
        actor: 'agent',
      }),
    );
    // No es una acción relajada por un modo: sin relaxedBy.
    expect(mockEmit.mock.calls[0]?.[1]).not.toHaveProperty('relaxedBy');
  });

  it('tool auto: NO emite notificación (BLUEPRINT 9.1: auto ejecuta sin notificar)', async () => {
    toolExecutorRegistry.register(
      'listCalendarEvents',
      vi.fn().mockResolvedValue([]),
    );
    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [{ id: 'c1', name: 'listCalendarEvents', input: {} }],
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ content: 'ok' }));

    await service.runTurn({ sessionId: 's', objective: 'x' });

    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('ADR 0010: una acción confirm relajada por el modo se EJECUTA, se audita como autoejecutada y se notifica diciendo por qué', async () => {
    const executor = vi.fn().mockResolvedValue('enviado');
    toolExecutorRegistry.register('runCode', executor);
    mockAutonomyService.relax = vi.fn((d: HitlDecision) =>
      Promise.resolve({
        ...d,
        level: 'notify' as const,
        approvalsRequired: 0 as const,
        notifyAfterExecution: true,
        relaxedBy: 'autonomy:semi-auto',
      }),
    );
    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [
            {
              id: 'c1',
              name: 'runCode',
              input: { language: 'typescript', code: '1+1' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ content: 'hecho' }));

    const result = await service.runTurn({ sessionId: 's', objective: 'x' });

    expect(executor).toHaveBeenCalledTimes(1);
    expect(mockDualConfirm.createPendingApproval).not.toHaveBeenCalled();
    expect(result.pendingApprovals).toHaveLength(0);
    expect(mockAuditService.recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'runCode',
        approvalStatus: 'notified',
        planSummary: expect.stringContaining(
          'autonomy:semi-auto',
        ) as unknown as string,
      }),
    );
    expect(mockEmit).toHaveBeenCalledWith(
      HITL_ACTION_NOTIFIED_EVENT,
      expect.objectContaining({
        toolName: 'runCode',
        relaxedBy: 'autonomy:semi-auto',
      }),
    );
  });

  it('ADR 0010: sin modo activo (supervised) una tool confirm SIGUE difiriéndose (default seguro)', async () => {
    const executor = vi.fn();
    toolExecutorRegistry.register('runCode', executor);
    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [
            {
              id: 'c1',
              name: 'runCode',
              input: { language: 'typescript', code: '1' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ content: 'ok' }));

    const result = await service.runTurn({ sessionId: 's', objective: 'x' });

    expect(executor).not.toHaveBeenCalled();
    expect(result.pendingApprovals).toHaveLength(1);
  });

  it('tool confirm: NO ejecuta — difiere con createPendingApproval y queda en pendingApprovals', async () => {
    const executor = vi.fn().mockResolvedValue('no debería llamarse');
    toolExecutorRegistry.register('sendEmail', executor);

    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [
            {
              id: 'call-1',
              name: 'sendEmail',
              input: { to: 'x@y.com', subject: 'hola', body: 'mundo' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        fakeResponse({ content: 'correo pendiente de aprobación' }),
      );

    const result = await service.runTurn({
      sessionId: 'sess-1',
      objective: 'mándale un correo a x@y.com',
    });

    expect(executor).not.toHaveBeenCalled();
    expect(mockAuditService.recordToolCall).not.toHaveBeenCalled();
    expect(mockDualConfirm.createPendingApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'sendEmail',
        level: 'confirm',
        payload: { to: 'x@y.com', subject: 'hola', body: 'mundo' },
        actor: 'agent',
      }),
    );
    expect(result.pendingApprovals).toHaveLength(1);
    expect(result.pendingApprovals[0]?.toolName).toBe('sendEmail');
  });

  it('tool confirm precedida por una tool auto en el mismo turno: createPendingApproval recibe externalInputsSummary con la traza real', async () => {
    const readEmailsExecutor = vi
      .fn()
      .mockResolvedValue([{ from: 'prof@uni.edu', subject: 'Asesoría' }]);
    toolExecutorRegistry.register('readEmails', readEmailsExecutor);
    toolExecutorRegistry.register(
      'sendEmail',
      vi.fn().mockResolvedValue('no debería llamarse'),
    );

    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [{ id: 'call-1', name: 'readEmails', input: {} }],
        }),
      )
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [
            {
              id: 'call-2',
              name: 'sendEmail',
              input: {
                to: 'prof@uni.edu',
                subject: 'Re: Asesoría',
                body: 'Ok.',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        fakeResponse({ content: 'correo pendiente de aprobación' }),
      );

    await service.runTurn({
      sessionId: 'sess-1',
      objective: 'revisá mis correos y respondé al del profe',
      actorLabel: 'web-chat',
    });

    expect(readEmailsExecutor).toHaveBeenCalledTimes(1);
    expect(mockDualConfirm.createPendingApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'sendEmail',
        actor: 'web-chat',
        externalInputsSummary: 'readEmails (1)',
      }),
    );
  });

  it('tool desconocida (alucinada por el modelo): no crashea, vuelve error y cuenta como fallo', async () => {
    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [
            { id: 'call-1', name: 'borrarTodoElUniverso', input: {} },
          ],
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ content: 'no pude hacer eso' }));

    const result = await service.runTurn({
      sessionId: 'sess-1',
      objective: 'algo',
    });

    expect(result.finalResponse).toBe('no pude hacer eso');
    expect(mockDualConfirm.createPendingApproval).not.toHaveBeenCalled();
  });

  it('cap de fallos consecutivos: tras N fallos de la MISMA tool+args, no se reintenta más (no llama al executor de nuevo)', async () => {
    const executor = vi.fn().mockRejectedValue(new Error('API caída'));
    toolExecutorRegistry.register('listCalendarEvents', executor);

    const sameCall = {
      id: 'call-x',
      name: 'listCalendarEvents',
      input: { maxResults: 5 },
    };
    completeMock
      .mockResolvedValueOnce(
        fakeResponse({ stopReason: 'tool_use', toolCalls: [sameCall] }),
      )
      .mockResolvedValueOnce(
        fakeResponse({ stopReason: 'tool_use', toolCalls: [sameCall] }),
      )
      .mockResolvedValueOnce(
        fakeResponse({ stopReason: 'tool_use', toolCalls: [sameCall] }),
      )
      .mockResolvedValueOnce(fakeResponse({ content: 'me rindo' }));

    await service.runTurn({ sessionId: 'sess-1', objective: 'algo' });

    // config.maxConsecutiveToolFailures = 2: el executor se llama las
    // primeras 2 veces (fallan), la 3ra se corta ANTES de llamar al executor.
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('límite global de iteraciones: corta el turno aunque el modelo siga pidiendo tools', async () => {
    const executor = vi.fn().mockResolvedValue('ok');
    toolExecutorRegistry.register('listCalendarEvents', executor);
    completeMock.mockResolvedValue(
      fakeResponse({
        stopReason: 'tool_use',
        toolCalls: [{ id: 'call-1', name: 'listCalendarEvents', input: {} }],
      }),
    );

    const result = await service.runTurn({
      sessionId: 'sess-1',
      objective: 'algo',
    });

    expect(result.iterationsUsed).toBe(config.maxIterationsPerTurn);
    expect(result.finalResponse).toMatch(/límite de iteraciones/);
  });

  describe('compresión de historial (docs/RECOMENDACIONES.md #2)', () => {
    let compactingService: AgentService;

    beforeEach(() => {
      compactingService = new AgentService(
        mockRouter as unknown as BudgetGuardedModelRouter,
        toolExecutorRegistry,
        mockDualConfirm as DualConfirmService,
        mockAuditService as AuditService,
        mockHistoryCompactionService as HistoryCompactionService,
        mockFeatureFlagsService as FeatureFlagsService,
        hitlPolicyService,
        { emit: mockEmit } as unknown as EventEmitter2,
        {
          ...config,
          maxHistoryTokens: 10,
          preserveLastTurns: 1,
        },
      );
    });

    it('si el historial estimado supera el umbral, devuelve compactedHistory con el resumen + últimos preserveLastTurns verbatim', async () => {
      const oldHistory = [
        { role: 'user' as const, content: 'objective viejo '.repeat(30) },
        { role: 'assistant' as const, content: 'respuesta vieja '.repeat(30) },
      ];
      completeMock.mockResolvedValueOnce(
        fakeResponse({ content: 'respuesta final' }),
      );
      const summaryMessage = {
        role: 'user' as const,
        content: '[Resumen automático de turnos previos]\nresumen',
      };
      (mockHistoryCompactionService.compact as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockResolvedValue(summaryMessage);

      const result = await compactingService.runTurn({
        sessionId: 'sess-1',
        objective: 'objective actual',
        history: oldHistory,
      });

      expect(mockHistoryCompactionService.compact).toHaveBeenCalledWith(
        'sess-1',
        {
          toCompact: oldHistory,
          toPreserve: [{ role: 'user', content: 'objective actual' }],
        },
      );
      expect(result.compactedHistory).toEqual([
        summaryMessage,
        { role: 'user', content: 'objective actual' },
      ]);
    });

    it('si el historial está bajo el umbral, no llama a compact() ni incluye compactedHistory', async () => {
      completeMock.mockResolvedValueOnce(
        fakeResponse({ content: 'respuesta final' }),
      );

      const result = await compactingService.runTurn({
        sessionId: 'sess-1',
        objective: 'hola',
      });

      expect(mockHistoryCompactionService.compact).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('compactedHistory');
    });

    it('si compact() falla (devuelve undefined), el turno igual responde normalmente, sin compactedHistory', async () => {
      const oldHistory = [
        { role: 'user' as const, content: 'objective viejo '.repeat(30) },
        { role: 'assistant' as const, content: 'respuesta vieja '.repeat(30) },
      ];
      completeMock.mockResolvedValueOnce(
        fakeResponse({ content: 'respuesta final' }),
      );
      (mockHistoryCompactionService.compact as ReturnType<typeof vi.fn>) = vi
        .fn()
        .mockResolvedValue(undefined);

      const result = await compactingService.runTurn({
        sessionId: 'sess-1',
        objective: 'objective actual',
        history: oldHistory,
      });

      expect(result.finalResponse).toBe('respuesta final');
      expect(result).not.toHaveProperty('compactedHistory');
    });
  });
});
