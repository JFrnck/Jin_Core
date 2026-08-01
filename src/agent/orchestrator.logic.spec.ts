import { describe, expect, it } from 'vitest';
import {
  buildBoardContextMessages,
  chunk,
  computeReadyBatch,
  computeRunStatus,
} from './orchestrator.logic';
import type { ReconciliationOutput, Ticket } from './orchestrator.types';

function ticket(overrides: Partial<Ticket> & Pick<Ticket, 'id'>): Ticket {
  return {
    runId: 'run-1',
    description: 'ticket de prueba',
    status: 'pending',
    assignedSubAgentId: null,
    allowedTools: [],
    dependsOn: [],
    result: null,
    ...overrides,
  };
}

describe('computeReadyBatch', () => {
  it('tickets sin dependencias están listos de inmediato', () => {
    const tickets = [ticket({ id: 'a' }), ticket({ id: 'b' })];
    expect(computeReadyBatch(tickets).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('respeta el orden de dependencias: un ticket con dependsOn no listo no aparece en el batch', () => {
    const tickets = [
      ticket({ id: 'a', status: 'pending' }),
      ticket({ id: 'b', status: 'pending', dependsOn: ['a'] }),
    ];
    expect(computeReadyBatch(tickets).map((t) => t.id)).toEqual(['a']);
  });

  it('un ticket queda listo recién cuando TODAS sus dependencias están done', () => {
    const tickets = [
      ticket({ id: 'a', status: 'done' }),
      ticket({ id: 'b', status: 'pending' }),
      ticket({ id: 'c', status: 'pending', dependsOn: ['a', 'b'] }),
    ];
    expect(computeReadyBatch(tickets).map((t) => t.id)).toEqual(['b']);
  });

  it('un ticket bloqueado nunca desbloquea a sus dependientes (se quedan pending para siempre en este run)', () => {
    const tickets = [
      ticket({ id: 'a', status: 'blocked' }),
      ticket({ id: 'b', status: 'pending', dependsOn: ['a'] }),
    ];
    expect(computeReadyBatch(tickets)).toEqual([]);
  });

  it('ignora tickets que ya no están pending (in-progress/done/failed/blocked)', () => {
    const tickets = [
      ticket({ id: 'a', status: 'in-progress' }),
      ticket({ id: 'b', status: 'done' }),
      ticket({ id: 'c', status: 'failed' }),
    ];
    expect(computeReadyBatch(tickets)).toEqual([]);
  });
});

describe('chunk', () => {
  it('agrupa en chunks del tamaño pedido, preservando el orden', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('un tamaño mayor al total devuelve un solo chunk', () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });

  it('lanza si size < 1', () => {
    expect(() => chunk([1], 0)).toThrow();
  });
});

describe('computeRunStatus', () => {
  it('todos done, sin conflictos -> done', () => {
    const tickets = [ticket({ id: 'a', status: 'done' })];
    expect(computeRunStatus(tickets, null)).toBe('done');
  });

  it('algún ticket pending/in-progress/blocked -> blocked', () => {
    expect(
      computeRunStatus([ticket({ id: 'a', status: 'blocked' })], null),
    ).toBe('blocked');
    expect(
      computeRunStatus([ticket({ id: 'a', status: 'in-progress' })], null),
    ).toBe('blocked');
  });

  it('todos resueltos pero con un conflicto material sin resolver -> blocked', () => {
    const tickets = [ticket({ id: 'a', status: 'done' })];
    const reconciliation: ReconciliationOutput = {
      finalResponse: 'hay un conflicto',
      conflicts: [
        {
          ticketIds: ['a'],
          summary: 'contradicción',
          riskLevel: 'material',
          proposedResolution: 'preguntarle al owner',
        },
      ],
    };
    expect(computeRunStatus(tickets, reconciliation)).toBe('blocked');
  });

  it('conflicto de bajo riesgo ya resuelto no bloquea el run', () => {
    const tickets = [ticket({ id: 'a', status: 'done' })];
    const reconciliation: ReconciliationOutput = {
      finalResponse: 'resuelto en modo-auto',
      conflicts: [
        {
          ticketIds: ['a'],
          summary: 'discrepancia menor',
          riskLevel: 'low',
          proposedResolution: 'se quedó con el resultado más reciente',
        },
      ],
    };
    expect(computeRunStatus(tickets, reconciliation)).toBe('done');
  });

  it('ningún pendiente, pero hay uno failed -> failed', () => {
    const tickets = [
      ticket({ id: 'a', status: 'done' }),
      ticket({ id: 'b', status: 'failed' }),
    ];
    expect(computeRunStatus(tickets, null)).toBe('failed');
  });
});

describe('buildBoardContextMessages', () => {
  it('sin siblings completados -> array vacío (nada que inyectar)', () => {
    expect(buildBoardContextMessages([])).toEqual([]);
  });

  it('con siblings -> par sintético user/assistant, mismo patrón que memoria en Fase 5.3', () => {
    const siblings = [
      ticket({
        id: 'a',
        description: 'leer correo',
        result: '3 correos nuevos',
      }),
    ];

    const messages = buildBoardContextMessages(siblings);

    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('user');
    expect(messages[0]!.content).toContain('leer correo');
    expect(messages[0]!.content).toContain('3 correos nuevos');
    expect(messages[1]!.role).toBe('assistant');
  });
});
