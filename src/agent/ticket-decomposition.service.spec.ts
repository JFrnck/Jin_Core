import { describe, expect, it, vi } from 'vitest';
import type { BudgetGuardedModelRouter } from '../budget/budget-guarded-router.service';
import type { ModelCompletionResponse } from '../model-provider/model-provider.types';
import type { ToolDefinition } from '../tools/registry';
import { TicketDecompositionParseError } from './errors';
import { TicketDecompositionService } from './ticket-decomposition.service';

const CATALOG: ToolDefinition[] = [
  {
    name: 'readEmails',
    hitlLevel: 'auto',
    description: 'lee correos',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'listCalendarEvents',
    hitlLevel: 'auto',
    description: 'lista eventos',
    inputSchema: { type: 'object', properties: {} },
  },
];

function makeService(response: ModelCompletionResponse): {
  service: TicketDecompositionService;
  completeMock: ReturnType<typeof vi.fn>;
} {
  const completeMock = vi.fn().mockResolvedValue(response);
  const mockRouter: Partial<BudgetGuardedModelRouter> = {
    complete: completeMock,
  };
  return {
    service: new TicketDecompositionService(
      mockRouter as BudgetGuardedModelRouter,
    ),
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

describe('TicketDecompositionService.decompose', () => {
  it('llama al TaskProfile reasoning_heavy con el runId como sessionId y parsea el JSON devuelto', async () => {
    const { service, completeMock } = makeService(
      fakeResponse(
        JSON.stringify([
          {
            description: 'leer correo',
            allowedTools: ['readEmails'],
            dependsOnIndexes: [],
          },
          {
            description: 'proponer agenda',
            allowedTools: ['listCalendarEvents'],
            dependsOnIndexes: [0],
          },
        ]),
      ),
    );

    const drafts = await service.decompose('run-1', 'revisa mi día', CATALOG);

    expect(drafts).toEqual([
      {
        description: 'leer correo',
        allowedTools: ['readEmails'],
        dependsOnIndexes: [],
      },
      {
        description: 'proponer agenda',
        allowedTools: ['listCalendarEvents'],
        dependsOnIndexes: [0],
      },
    ]);
    expect(completeMock).toHaveBeenCalledWith(
      'reasoning_heavy',
      expect.anything(),
      undefined,
      'run-1',
    );
  });

  it('descarta silenciosamente (con warning) un nombre de tool alucinado que no existe en el catálogo', async () => {
    const { service } = makeService(
      fakeResponse(
        JSON.stringify([
          {
            description: 'ticket',
            allowedTools: ['readEmails', 'borrarTodoElUniverso'],
            dependsOnIndexes: [],
          },
        ]),
      ),
    );

    const drafts = await service.decompose('run-1', 'objetivo', CATALOG);

    expect(drafts[0]!.allowedTools).toEqual(['readEmails']);
  });

  it('lanza TicketDecompositionParseError si la respuesta no es JSON válido', async () => {
    const { service } = makeService(fakeResponse('esto no es JSON'));

    await expect(
      service.decompose('run-1', 'objetivo', CATALOG),
    ).rejects.toThrow(TicketDecompositionParseError);
  });

  it('lanza TicketDecompositionParseError si el JSON no matchea el schema (array vacío, min 1)', async () => {
    const { service } = makeService(fakeResponse('[]'));

    await expect(
      service.decompose('run-1', 'objetivo', CATALOG),
    ).rejects.toThrow(TicketDecompositionParseError);
  });
});
