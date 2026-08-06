import { EventEmitterModule } from '@nestjs/event-emitter';
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
import { DB_CONNECTION } from '../db/db.module';
import { auditLog, pendingApprovals } from '../db/schema';
import { ApprovalExecutionService } from './approval-execution.service';
import {
  DualConfirmService,
  PendingApprovalNotFoundError,
} from './dual-confirm.service';
import { ToolExecutorRegistry } from './tool-executor.registry';

describe('ApprovalExecutionService (integración, Postgres real)', () => {
  let testDb: TestDb;
  let service: ApprovalExecutionService;
  let dualConfirmService: DualConfirmService;
  let toolExecutorRegistry: ToolExecutorRegistry;

  beforeAll(async () => {
    testDb = await startTestDb();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        ApprovalExecutionService,
        DualConfirmService,
        AuditService,
        ChainVerificationService,
        ToolExecutorRegistry,
        { provide: DB_CONNECTION, useValue: testDb.db },
      ],
    }).compile();
    service = moduleRef.get(ApprovalExecutionService);
    dualConfirmService = moduleRef.get(DualConfirmService);
    toolExecutorRegistry = moduleRef.get(ToolExecutorRegistry);
  }, 30_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.db.delete(pendingApprovals);
    await testDb.db.delete(auditLog);
  });

  it('resolveAndExecute (confirm): ejecuta el executor registrado con el payload exacto, audita y limpia el pendiente', async () => {
    const executor = vi.fn().mockResolvedValue('email-enviado-123');
    toolExecutorRegistry.register('sendEmail', executor);
    await dualConfirmService.createPendingApproval({
      requestId: '11111111-1111-4111-8111-111111111111',
      toolName: 'sendEmail',
      level: 'confirm',
      inputsHash: 'h1',
      payload: { to: 'a@b.com', subject: 'Hola', body: 'Mundo' },
    });

    const result = await service.resolveAndExecute(
      '11111111-1111-4111-8111-111111111111',
      'owner',
    );

    expect(result).toEqual({
      outcome: 'resolved',
      toolName: 'sendEmail',
      result: 'email-enviado-123',
    });
    expect(executor).toHaveBeenCalledWith({
      to: 'a@b.com',
      subject: 'Hola',
      body: 'Mundo',
    });

    const pending = await dualConfirmService.getPending(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(pending).toBeUndefined();

    // 2 filas ahora, no 1: `createPendingApproval` (docs/RECOMENDACIONES.md
    // #13) escribe una fila `tool_call`/pending permanente ANTES de la
    // resolución — sobrevive aunque el pending se borre, a diferencia de
    // antes de este fix.
    const auditRows = await testDb.db.select().from(auditLog);
    expect(auditRows).toHaveLength(2);
    const pendingRow = auditRows.find((r) => r.approvalStatus === 'pending');
    const approvalRow = auditRows.find((r) => r.actionType === 'approval');
    expect(pendingRow?.toolName).toBe('sendEmail');
    expect(approvalRow?.toolName).toBe('sendEmail');
  });

  it('resolveAndExecute (dual-confirm): la primera aprobación NO ejecuta nada', async () => {
    const executor = vi.fn().mockResolvedValue('borrado');
    toolExecutorRegistry.register('deleteCalendarEventFuture', executor);
    await dualConfirmService.createPendingApproval({
      requestId: '22222222-2222-4222-8222-222222222222',
      toolName: 'deleteCalendarEventFuture',
      level: 'dual-confirm',
      inputsHash: 'h2',
      payload: { eventId: 'evt-1' },
    });

    const result = await service.resolveAndExecute(
      '22222222-2222-4222-8222-222222222222',
      'owner',
    );

    expect(result).toEqual({ outcome: 'awaiting-second' });
    expect(executor).not.toHaveBeenCalled();

    // 1 fila (pending), no 0: la primera aprobación de un dual-confirm no
    // ejecuta ni audita nada por sí misma, pero `createPendingApproval` ya
    // había escrito la fila permanente al crearse el pending.
    const auditRows = await testDb.db.select().from(auditLog);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.approvalStatus).toBe('pending');
  });

  it('resolveAndExecute lanza PendingApprovalNotFoundError si el requestId no existe', async () => {
    await expect(
      service.resolveAndExecute(
        '33333333-3333-4333-8333-333333333333',
        'owner',
      ),
    ).rejects.toThrow(PendingApprovalNotFoundError);
  });

  it('resolveRejection nunca ejecuta el executor, solo audita y limpia el pendiente', async () => {
    const executor = vi.fn().mockResolvedValue('no-deberia-llamarse');
    toolExecutorRegistry.register('updateCalendarEvent', executor);
    await dualConfirmService.createPendingApproval({
      requestId: '44444444-4444-4444-8444-444444444444',
      toolName: 'updateCalendarEvent',
      level: 'confirm',
      inputsHash: 'h4',
      payload: { to: 'a@b.com' },
    });

    await service.resolveRejection(
      '44444444-4444-4444-8444-444444444444',
      'owner',
    );

    expect(executor).not.toHaveBeenCalled();

    const pending = await dualConfirmService.getPending(
      '44444444-4444-4444-8444-444444444444',
    );
    expect(pending).toBeUndefined();

    // 2 filas ahora, no 1 — mismo motivo que el test de resolveAndExecute
    // de arriba: la fila pending permanente + la fila terminal de rejection.
    const auditRows = await testDb.db.select().from(auditLog);
    expect(auditRows).toHaveLength(2);
    expect(auditRows.some((r) => r.approvalStatus === 'pending')).toBe(true);
    expect(auditRows.some((r) => r.actionType === 'rejection')).toBe(true);
  });

  it('resolveRejection lanza PendingApprovalNotFoundError si el requestId no existe', async () => {
    await expect(
      service.resolveRejection('55555555-5555-4555-8555-555555555555', 'owner'),
    ).rejects.toThrow(PendingApprovalNotFoundError);
  });
});
