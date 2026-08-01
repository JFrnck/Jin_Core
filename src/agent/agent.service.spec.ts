import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { BudgetGuardedModelRouter } from '../budget/budget-guarded-router.service';
import { DualConfirmService } from '../hitl/dual-confirm.service';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import type {
  ModelCompletionRequest,
  ModelCompletionResponse,
  ModelMessageContentBlock,
} from '../model-provider/model-provider.types';
import type { AgentConfig } from './agent-config.schema';
import { AgentService } from './agent.service';

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
    config = {
      maxIterationsPerTurn: 5,
      maxConsecutiveToolFailures: 2,
      maxConcurrentSubAgents: 3,
    };

    service = new AgentService(
      mockRouter as unknown as BudgetGuardedModelRouter,
      toolExecutorRegistry,
      mockDualConfirm as DualConfirmService,
      mockAuditService as AuditService,
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
    });
    expect(completeMock).toHaveBeenCalledTimes(1);
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
      }),
    );
    expect(result.pendingApprovals).toHaveLength(1);
    expect(result.pendingApprovals[0]?.toolName).toBe('sendEmail');
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
});
