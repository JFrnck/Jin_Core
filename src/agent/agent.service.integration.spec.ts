import { Test, type TestingModule } from '@nestjs/testing';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  startTestDb,
  type TestDb,
} from '../../test/support/postgres-testcontainer';
import { AuditService } from '../audit/audit.service';
import { ChainVerificationService } from '../audit/chain-verification.service';
import type { BudgetGuardedModelRouter } from '../budget/budget-guarded-router.service';
import { DB_CONNECTION } from '../db/db.module';
import { auditLog, pendingApprovals } from '../db/schema';
import { DualConfirmService } from '../hitl/dual-confirm.service';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import type { ModelCompletionResponse } from '../model-provider/model-provider.types';
import type { AgentConfig } from './agent-config.schema';
import { AgentService } from './agent.service';

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

describe('AgentService.runTurn (integración, Postgres real)', () => {
  let testDb: TestDb;
  let dualConfirmService: DualConfirmService;
  let auditService: AuditService;
  let toolExecutorRegistry: ToolExecutorRegistry;
  let completeMock: ReturnType<typeof vi.fn>;
  let service: AgentService;
  const config: AgentConfig = {
    maxIterationsPerTurn: 5,
    maxConsecutiveToolFailures: 2,
    maxConcurrentSubAgents: 3,
  };

  beforeAll(async () => {
    testDb = await startTestDb();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        DualConfirmService,
        AuditService,
        ChainVerificationService,
        ToolExecutorRegistry,
        { provide: DB_CONNECTION, useValue: testDb.db },
      ],
    }).compile();
    dualConfirmService = moduleRef.get(DualConfirmService);
    auditService = moduleRef.get(AuditService);
    toolExecutorRegistry = moduleRef.get(ToolExecutorRegistry);
  }, 30_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.db.delete(pendingApprovals);
    await testDb.db.delete(auditLog);
    completeMock = vi.fn();
    service = new AgentService(
      { complete: completeMock } as unknown as BudgetGuardedModelRouter,
      toolExecutorRegistry,
      dualConfirmService,
      auditService,
      config,
    );
  });

  it('tool confirm: crea una pending approval real en Postgres con el payload exacto, sin ejecutar nada', async () => {
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
        fakeResponse({ content: 'queda pendiente de aprobación' }),
      );

    const result = await service.runTurn({
      sessionId: 'sess-1',
      objective: 'mándale un correo a x@y.com',
    });

    expect(executor).not.toHaveBeenCalled();
    expect(result.pendingApprovals).toHaveLength(1);
    const requestId = result.pendingApprovals[0]?.requestId;
    expect(requestId).toBeTruthy();

    const pending = await dualConfirmService.getPending(requestId!);
    expect(pending).toBeDefined();
    expect(pending?.toolName).toBe('sendEmail');
    expect(pending?.level).toBe('confirm');
    expect(pending?.payload).toEqual({
      to: 'x@y.com',
      subject: 'hola',
      body: 'mundo',
    });

    // No se auditó todavía — el audit de una tool confirm ocurre recién
    // al aprobarse, vía ApprovalExecutionService (PR #8), no acá.
    const auditRows = await testDb.db.select().from(auditLog);
    expect(auditRows).toHaveLength(0);
  });

  it('tool auto: ejecuta ya y deja una fila real en audit_log con actor "agent"', async () => {
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

    const auditRows = await testDb.db.select().from(auditLog);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actor).toBe('agent');
    expect(auditRows[0]?.toolName).toBe('listCalendarEvents');
    expect(auditRows[0]?.approvalStatus).toBe('auto');
    expect(auditRows[0]?.actionType).toBe('tool_call');
  });

  it('dos tools en el mismo turno (una auto, una confirm) dejan el estado correcto de cada una', async () => {
    // Nombres distintos a los de los tests anteriores: ToolExecutorRegistry
    // se comparte entre los tests de este archivo (una sola instancia vía
    // beforeAll) y lanza si se registra el mismo toolName dos veces.
    const listExecutor = vi.fn().mockResolvedValue([]);
    toolExecutorRegistry.register('canvasListAssignments', listExecutor);
    const deleteExecutor = vi.fn();
    toolExecutorRegistry.register('deleteCalendarEventFuture', deleteExecutor);

    completeMock
      .mockResolvedValueOnce(
        fakeResponse({
          stopReason: 'tool_use',
          toolCalls: [
            { id: 'call-1', name: 'canvasListAssignments', input: {} },
            {
              id: 'call-2',
              name: 'deleteCalendarEventFuture',
              input: { eventId: 'evt-1' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(fakeResponse({ content: 'listo' }));

    const result = await service.runTurn({
      sessionId: 'sess-1',
      objective: 'revisá mis tareas y borrá el evento evt-1',
    });

    expect(listExecutor).toHaveBeenCalled();
    expect(deleteExecutor).not.toHaveBeenCalled();
    expect(result.pendingApprovals).toHaveLength(1);

    const auditRows = await testDb.db.select().from(auditLog);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.toolName).toBe('canvasListAssignments');

    const pendingRows = await testDb.db.select().from(pendingApprovals);
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]?.toolName).toBe('deleteCalendarEventFuture');
  });
});
