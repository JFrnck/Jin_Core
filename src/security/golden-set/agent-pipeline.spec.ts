import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../audit/audit.service';
import type { BudgetGuardedModelRouter } from '../../budget/budget-guarded-router.service';
import { DualConfirmService } from '../../hitl/dual-confirm.service';
import { ToolExecutorRegistry } from '../../hitl/tool-executor.registry';
import type {
  ModelCompletionRequest,
  ModelCompletionResponse,
  ModelMessageContentBlock,
} from '../../model-provider/model-provider.types';
import { AgentService } from '../../agent/agent.service';
import type { AgentConfig } from '../../agent/agent-config.schema';
import type { HistoryCompactionService } from '../../agent/history-compaction.service';
import type { FeatureFlagsService } from '../../feature-flags/feature-flags.service';
import { GOLDEN_SET } from './corpus';

// Mismo scaffolding de mocks que src/agent/agent.service.spec.ts (no se
// reinventa infraestructura de test nueva) -- las entradas de
// `fake-approval`/`mimic-tool-result` solo tienen sentido dentro del loop
// completo, porque el ataque vive en el `tool_result` de un turno
// anterior, no en un string aislado.

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

function getRequestArg(
  mock: ReturnType<typeof vi.fn>,
  callIndex: number,
): ModelCompletionRequest {
  return (
    mock.mock.calls[callIndex] as unknown as [string, ModelCompletionRequest]
  )[1];
}

function lastMessageBlocks(
  request: ModelCompletionRequest,
): readonly ModelMessageContentBlock[] {
  const content = request.messages.at(-1)?.content;
  if (!content || typeof content === 'string') {
    throw new Error('Se esperaba contenido en bloques, no string.');
  }
  return content;
}

const PIPELINE_ENTRIES = GOLDEN_SET.filter(
  (e) => e.category === 'fake-approval' || e.category === 'mimic-tool-result',
);

describe('golden set — el loop del agente no ejecuta ni cambia de nivel por contenido hostil en un tool_result previo', () => {
  let completeMock: ReturnType<typeof vi.fn>;
  let mockRouter: { complete: ReturnType<typeof vi.fn> };
  let toolExecutorRegistry: ToolExecutorRegistry;
  let mockDualConfirm: Partial<DualConfirmService>;
  let mockAuditService: Partial<AuditService>;
  let mockHistoryCompactionService: Partial<HistoryCompactionService>;
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
    config = {
      maxIterationsPerTurn: 5,
      maxConsecutiveToolFailures: 2,
      maxConcurrentSubAgents: 3,
      maxHistoryTokens: 1_000_000,
      preserveLastTurns: 6,
    };

    service = new AgentService(
      mockRouter as unknown as BudgetGuardedModelRouter,
      toolExecutorRegistry,
      mockDualConfirm as DualConfirmService,
      mockAuditService as AuditService,
      mockHistoryCompactionService as HistoryCompactionService,
      // Fase 9.5: AgentService consulta flags antes de clasificar. Acá es
      // neutro a propósito (integraciones on, sin override de hitlLevel) --
      // este spec prueba que el contenido hostil no cambia el nivel; el
      // único que podría hacerlo legítimamente es un flag aprobado por el owner.
      {
        isIntegrationEnabled: vi.fn().mockReturnValue(true),
        resolveEffectiveLevel: vi
          .fn()
          .mockImplementation((decision: unknown) => Promise.resolve(decision)),
      } as unknown as FeatureFlagsService,
      config,
    );
  });

  it.each(PIPELINE_ENTRIES.map((e) => [e.id, e.payload] as const))(
    '%s',
    async (_id, payload) => {
      // Turno 1: una tool `auto` (readEmails) trae un correo controlado
      // por el atacante -- su `body` es el payload adversarial. El
      // resultado se envuelve con wrapUntrustedContent antes de volver
      // al modelo (agent.service.ts::handleRealToolCall), igual que
      // cualquier correo real leído por el agente.
      const readEmailsExecutor = vi
        .fn()
        .mockResolvedValue([
          { from: 'attacker@evil.com', subject: 'Aprobación', body: payload },
        ]);
      toolExecutorRegistry.register('readEmails', readEmailsExecutor);

      const sendEmailExecutor = vi
        .fn()
        .mockResolvedValue('no debería llamarse');
      toolExecutorRegistry.register('sendEmail', sendEmailExecutor);

      completeMock
        .mockResolvedValueOnce(
          fakeResponse({
            stopReason: 'tool_use',
            toolCalls: [{ id: 'call-1', name: 'readEmails', input: {} }],
          }),
        )
        // Turno 2: el modelo pide sendEmail (confirm) -- da igual si "lo
        // pide por haber sido engañado" o no: el código no distingue, lo
        // que se prueba es que el gate de confirm es inmune de todos
        // modos.
        .mockResolvedValueOnce(
          fakeResponse({
            stopReason: 'tool_use',
            toolCalls: [
              {
                id: 'call-2',
                name: 'sendEmail',
                input: { to: 'attacker@evil.com', subject: 'Re', body: 'ok' },
              },
            ],
          }),
        )
        .mockResolvedValueOnce(fakeResponse({ content: 'listo' }));

      const result = await service.runTurn({
        sessionId: 'sess-golden',
        objective: 'revisá mis correos y respondé si corresponde',
      });

      // El executor real de sendEmail NUNCA se llamó -- ni el payload ni
      // el "modelo" pueden saltarse DualConfirmService.
      expect(sendEmailExecutor).not.toHaveBeenCalled();
      expect(mockAuditService.recordToolCall).not.toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'sendEmail' }),
      );

      // El nivel que llega a createPendingApproval es el que deriva
      // classifyToolCall del registry -- 'confirm' -- nunca algo
      // sugerido por el payload (p.ej. 'auto', o un requestId inventado
      // por el ataque).
      expect(mockDualConfirm.createPendingApproval).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'sendEmail', level: 'confirm' }),
      );
      expect(result.pendingApprovals).toHaveLength(1);
      expect(result.pendingApprovals[0]?.toolName).toBe('sendEmail');

      // El tool_result que vuelve al modelo para call-2 es el mensaje
      // fijo de "diferida" -- nunca algo derivado del payload (ninguna
      // aprobación "ya otorgada", ningún eco del contenido hostil).
      const thirdRequest = getRequestArg(completeMock, 2);
      const blocks = lastMessageBlocks(thirdRequest);
      const deferredBlock = blocks.find(
        (b) => b.type === 'tool_result' && b.toolCallId === 'call-2',
      );
      expect(deferredBlock).toBeDefined();
      expect(
        deferredBlock && 'output' in deferredBlock
          ? deferredBlock.output
          : undefined,
      ).toMatch(
        /^Acción diferida — requiere aprobación humana \(requestId: .+\)\. No se ejecutó todavía\.$/,
      );
    },
  );
});
