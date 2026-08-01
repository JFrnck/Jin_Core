import { describe, expect, it, vi } from 'vitest';
import type { BudgetGuardedModelRouter } from '../budget/budget-guarded-router.service';
import type { ModelCompletionResponse } from '../model-provider/model-provider.types';
import { ReconciliationParseError } from './errors';
import type { Ticket } from './orchestrator.types';
import { ReconciliationService } from './reconciliation.service';

function makeService(response: ModelCompletionResponse): {
  service: ReconciliationService;
  completeMock: ReturnType<typeof vi.fn>;
} {
  const completeMock = vi.fn().mockResolvedValue(response);
  const mockRouter: Partial<BudgetGuardedModelRouter> = {
    complete: completeMock,
  };
  return {
    service: new ReconciliationService(mockRouter as BudgetGuardedModelRouter),
    completeMock,
  };
}

function fakeResponse(content: string): ModelCompletionResponse {
  return {
    content,
    modelId: 'claude-opus-4-8',
    stopReason: 'end_turn',
    inputTokens: 100,
    outputTokens: 50,
  };
}

function ticket(overrides: Partial<Ticket> & Pick<Ticket, 'id'>): Ticket {
  return {
    runId: 'run-1',
    description: 'ticket',
    status: 'done',
    assignedSubAgentId: null,
    allowedTools: [],
    dependsOn: [],
    result: null,
    ...overrides,
  };
}

describe('ReconciliationService.reconcile', () => {
  it('llama al TaskProfile reasoning_heavy con el runId como sessionId y parsea el JSON sin conflictos', async () => {
    const { service, completeMock } = makeService(
      fakeResponse(
        JSON.stringify({
          finalResponse: 'tenés 3 correos nuevos y 2 reuniones mañana.',
          conflicts: [],
        }),
      ),
    );
    const tickets = [ticket({ id: 'a', result: '3 correos' })];

    const result = await service.reconcile('run-1', tickets, new Map());

    expect(result.finalResponse).toBe(
      'tenés 3 correos nuevos y 2 reuniones mañana.',
    );
    expect(result.conflicts).toEqual([]);
    expect(completeMock).toHaveBeenCalledWith(
      'reasoning_heavy',
      expect.anything(),
      undefined,
      'run-1',
    );
  });

  it('detecta y devuelve un conflicto material entre sub-agentes — dispara la escalada al owner', async () => {
    const { service } = makeService(
      fakeResponse(
        JSON.stringify({
          finalResponse: 'hay una contradicción que necesita tu decisión.',
          conflicts: [
            {
              ticketIds: ['a', 'b'],
              summary:
                'un ticket dice que el evento es a las 10, otro a las 11',
              riskLevel: 'material',
              proposedResolution: 'confirmar con el calendario real',
            },
          ],
        }),
      ),
    );
    const tickets = [ticket({ id: 'a' }), ticket({ id: 'b' })];

    const result = await service.reconcile('run-1', tickets, new Map());

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.riskLevel).toBe('material');
    expect(result.conflicts[0]!.ticketIds).toEqual(['a', 'b']);
  });

  it('lanza ReconciliationParseError si la respuesta no es JSON válido', async () => {
    const { service } = makeService(fakeResponse('prosa, no JSON'));

    await expect(
      service.reconcile('run-1', [ticket({ id: 'a' })], new Map()),
    ).rejects.toThrow(ReconciliationParseError);
  });

  it('lanza ReconciliationParseError si falta un campo requerido (riskLevel)', async () => {
    const { service } = makeService(
      fakeResponse(
        JSON.stringify({
          finalResponse: 'ok',
          conflicts: [
            {
              ticketIds: ['a'],
              summary: 'x',
              proposedResolution: 'y',
            },
          ],
        }),
      ),
    );

    await expect(
      service.reconcile('run-1', [ticket({ id: 'a' })], new Map()),
    ).rejects.toThrow(ReconciliationParseError);
  });
});
