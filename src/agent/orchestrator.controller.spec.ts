import { describe, expect, it, vi } from 'vitest';
import type { Ticket, TicketComment } from './orchestrator.types';
import { RunNotFoundError } from './errors';
import type { LedgerRepository, RunSummary } from './ledger.repository';
import { OrchestratorController } from './orchestrator.controller';

function buildController(
  overrides?: Partial<LedgerRepository>,
): OrchestratorController {
  const repo: Partial<LedgerRepository> = {
    listRuns: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getRun: vi.fn().mockResolvedValue(null),
    getTickets: vi.fn().mockResolvedValue([]),
    getComments: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  return new OrchestratorController(repo as LedgerRepository);
}

describe('OrchestratorController', () => {
  it('listRuns delega en LedgerRepository.listRuns y devuelve un array mutable', async () => {
    const run: RunSummary = {
      id: 'run-1',
      objective: 'obj',
      status: 'running',
      parentSessionId: 's1',
      finalResponse: null,
      createdAt: new Date('2026-08-03T00:00:00.000Z'),
      completedAt: null,
    };
    const listRuns = vi
      .fn()
      .mockResolvedValue({ items: Object.freeze([run]), nextCursor: null });
    const controller = buildController({ listRuns });

    const result = await controller.listRuns({ limit: 20 });

    expect(listRuns).toHaveBeenCalledWith({ limit: 20 });
    expect(result).toEqual({ items: [run], nextCursor: null });
  });

  it('getRun lanza RunNotFoundError si el run no existe', async () => {
    const controller = buildController({
      getRun: vi.fn().mockResolvedValue(null),
    });

    await expect(controller.getRun('missing')).rejects.toThrow(
      RunNotFoundError,
    );
  });

  it('getRun arma tickets con su hilo de comentarios cada uno', async () => {
    const run: RunSummary = {
      id: 'run-1',
      objective: 'obj',
      status: 'running',
      parentSessionId: 's1',
      finalResponse: null,
      createdAt: new Date(),
      completedAt: null,
    };
    const ticket: Ticket = {
      id: 'ticket-1',
      runId: 'run-1',
      description: 'implementar parser',
      status: 'in-progress',
      assignedSubAgentId: 'sub-1',
      allowedTools: Object.freeze(['runCode']),
      dependsOn: Object.freeze([]),
      result: null,
    };
    const comment: TicketComment = {
      id: '1',
      ticketId: 'ticket-1',
      authorType: 'sub_agent',
      authorId: 'sub-1',
      kind: 'note',
      body: 'avanzando',
    };
    const controller = buildController({
      getRun: vi.fn().mockResolvedValue(run),
      getTickets: vi.fn().mockResolvedValue([ticket]),
      getComments: vi.fn().mockResolvedValue([comment]),
    });

    const result = await controller.getRun('run-1');

    expect(result.run).toEqual(run);
    expect(result.tickets).toEqual([{ ...ticket, comments: [comment] }]);
  });
});
