import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  startTestDb,
  type TestDb,
} from '../../test/support/postgres-testcontainer';
import { DB_CONNECTION } from '../db/db.module';
import {
  agentOrchestrationRuns,
  agentTicketComments,
  agentTickets,
} from '../db/schema';
import { LedgerRepository } from './ledger.repository';

describe('LedgerRepository (integración, Postgres real)', () => {
  let testDb: TestDb;
  let repo: LedgerRepository;

  beforeAll(async () => {
    testDb = await startTestDb();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        LedgerRepository,
        { provide: DB_CONNECTION, useValue: testDb.db },
      ],
    }).compile();
    repo = moduleRef.get(LedgerRepository);
  }, 30_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.db.delete(agentTicketComments);
    await testDb.db.delete(agentTickets);
    await testDb.db.delete(agentOrchestrationRuns);
  });

  it('createRun + createTickets resuelve dependsOnIndexes a los uuids reales generados', async () => {
    const runId = await repo.createRun({
      objective: 'revisa mi correo y calendario',
      parentSessionId: 'sess-1',
    });

    const tickets = await repo.createTickets(runId, [
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

    expect(tickets).toHaveLength(2);
    expect(tickets[1]!.dependsOn).toEqual([tickets[0]!.id]);

    const persisted = await repo.getTickets(runId);
    expect(persisted).toHaveLength(2);
    expect(persisted[1]!.dependsOn).toEqual([tickets[0]!.id]);
    expect(persisted[0]!.status).toBe('pending');
  });

  it('updateTicketStatus persiste status y result', async () => {
    const runId = await repo.createRun({
      objective: 'obj',
      parentSessionId: 'sess-1',
    });
    const [ticket] = await repo.createTickets(runId, [
      { description: 't1', allowedTools: [], dependsOnIndexes: [] },
    ]);

    await repo.updateTicketStatus(ticket!.id, 'done', 'listo');

    const [persisted] = await repo.getTickets(runId);
    expect(persisted!.status).toBe('done');
    expect(persisted!.result).toBe('listo');
  });

  it('addComment + getComments arma el hilo en orden — así se hace visible un conflicto (ADR 0005)', async () => {
    const runId = await repo.createRun({
      objective: 'obj',
      parentSessionId: 'sess-1',
    });
    const [ticket] = await repo.createTickets(runId, [
      { description: 't1', allowedTools: [], dependsOnIndexes: [] },
    ]);

    await repo.addComment({
      ticketId: ticket!.id,
      authorType: 'sub_agent',
      authorId: ticket!.id,
      kind: 'result',
      body: 'encontré 3 eventos',
    });
    await repo.addComment({
      ticketId: ticket!.id,
      authorType: 'orchestrator',
      kind: 'conflict',
      body: 'contradice lo que dijo otro sub-agente',
    });

    const comments = await repo.getComments(ticket!.id);
    expect(comments).toHaveLength(2);
    expect(comments[0]!.kind).toBe('result');
    expect(comments[1]!.kind).toBe('conflict');
  });

  it('getCompletedSiblings devuelve solo tickets done, excluyendo el propio', async () => {
    const runId = await repo.createRun({
      objective: 'obj',
      parentSessionId: 'sess-1',
    });
    const tickets = await repo.createTickets(runId, [
      { description: 't1', allowedTools: [], dependsOnIndexes: [] },
      { description: 't2', allowedTools: [], dependsOnIndexes: [] },
      { description: 't3', allowedTools: [], dependsOnIndexes: [] },
    ]);
    await repo.updateTicketStatus(tickets[0]!.id, 'done', 'ok');
    await repo.updateTicketStatus(tickets[1]!.id, 'in-progress');

    const siblings = await repo.getCompletedSiblings(runId, tickets[2]!.id);
    expect(siblings.map((t) => t.id)).toEqual([tickets[0]!.id]);
  });

  it('getRun devuelve null si no existe — el controller decide el 404', async () => {
    expect(
      await repo.getRun('00000000-0000-4000-8000-000000000000'),
    ).toBeNull();
  });

  it('getRun devuelve el resumen real de un run existente', async () => {
    const runId = await repo.createRun({
      objective: 'publicar dashboard de tesis',
      parentSessionId: 'sess-1',
    });

    const run = await repo.getRun(runId);

    expect(run).toMatchObject({
      id: runId,
      objective: 'publicar dashboard de tesis',
      status: 'running',
      parentSessionId: 'sess-1',
      finalResponse: null,
      completedAt: null,
    });
    expect(run?.createdAt).toBeInstanceOf(Date);
  });

  it('listRuns pagina más reciente primero, con cursor por createdAt', async () => {
    const id1 = await repo.createRun({
      objective: 'primero',
      parentSessionId: 's1',
    });
    await new Promise((r) => setTimeout(r, 10));
    const id2 = await repo.createRun({
      objective: 'segundo',
      parentSessionId: 's1',
    });
    await new Promise((r) => setTimeout(r, 10));
    const id3 = await repo.createRun({
      objective: 'tercero',
      parentSessionId: 's1',
    });

    const firstPage = await repo.listRuns({ limit: 2 });
    expect(firstPage.items.map((r) => r.id)).toEqual([id3, id2]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await repo.listRuns({
      limit: 2,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items.map((r) => r.id)).toEqual([id1]);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('completeRun persiste status final y finalResponse', async () => {
    const runId = await repo.createRun({
      objective: 'obj',
      parentSessionId: 'sess-1',
    });

    await repo.completeRun(runId, 'done', 'agenda propuesta con éxito');

    const [row] = await testDb.db
      .select()
      .from(agentOrchestrationRuns)
      .where(eq(agentOrchestrationRuns.id, runId));
    expect(row?.status).toBe('done');
    expect(row?.finalResponse).toBe('agenda propuesta con éxito');
    expect(row?.completedAt).not.toBeNull();
  });
});
