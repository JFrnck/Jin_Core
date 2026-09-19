import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
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
  ApprovalAlreadyResolvedError,
  DualConfirmService,
  PendingApprovalNotFoundError,
  SecondApprovalTooEarlyError,
} from './dual-confirm.service';
import { ToolExecutorRegistry } from './tool-executor.registry';

// Issue Jin_Core #36: `resolveAndExecute` leía el pendiente, ejecutaba la
// acción real y RECIÉN DESPUÉS lo borraba, sin reclamarlo antes. Dos
// aprobaciones casi simultáneas (Web + Telegram, doble clic, reintento de
// red) ejecutaban `sendEmail` dos veces. Estos tests fuerzan esa carrera
// contra un Postgres real: un executor con latencia deja la ventana abierta.
const CONCURRENCY = 10;
const REQUEST_ID = '66666666-6666-4666-8666-666666666666';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `ToolExecutorRegistry.register` rechaza registrar la misma tool dos veces
// (doble registro accidental), así que se registra UN delegado por tool y
// cada test cambia la implementación que ese delegado invoca.
type Executor = (payload: unknown) => Promise<unknown>;
const impl: Record<'sendEmail' | 'deleteCalendarEventFuture', Executor> = {
  sendEmail: () => Promise.reject(new Error('executor no configurado')),
  deleteCalendarEventFuture: () =>
    Promise.reject(new Error('executor no configurado')),
};

describe('ApprovalExecutionService — reclamo atómico (integración, Postgres real, #36)', () => {
  let testDb: TestDb;
  let service: ApprovalExecutionService;
  let dualConfirmService: DualConfirmService;
  let auditService: AuditService;
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
    auditService = moduleRef.get(AuditService);
    toolExecutorRegistry = moduleRef.get(ToolExecutorRegistry);
    toolExecutorRegistry.register('sendEmail', (p) => impl.sendEmail(p));
    toolExecutorRegistry.register('deleteCalendarEventFuture', (p) =>
      impl.deleteCalendarEventFuture(p),
    );
  }, 30_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    await testDb.db.delete(pendingApprovals);
    await testDb.db.delete(auditLog);
  });

  async function createConfirmPending(): Promise<void> {
    await dualConfirmService.createPendingApproval({
      requestId: REQUEST_ID,
      toolName: 'sendEmail',
      level: 'confirm',
      inputsHash: 'h-race',
      payload: { to: 'a@b.com', subject: 'Hola', body: 'Mundo' },
    });
  }

  it('N aprobaciones concurrentes del MISMO pendiente: el executor corre EXACTAMENTE una vez', async () => {
    const executor = vi.fn(async () => {
      await sleep(80); // ventana de carrera: la acción real tarda
      return 'email-enviado';
    });
    impl.sendEmail = executor;
    await createConfirmPending();

    const settled = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        service.resolveAndExecute(REQUEST_ID, 'owner'),
      ),
    );

    // Lo que importa: la acción irreversible ocurrió una sola vez.
    expect(executor).toHaveBeenCalledTimes(1);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    // El resto falla de forma explícita e idempotente (409 mientras se
    // ejecuta, 404 si ya se borró) -- nunca ejecuta ni corrompe nada.
    const rejected = settled.filter(
      (s): s is PromiseRejectedResult => s.status === 'rejected',
    );
    expect(rejected).toHaveLength(CONCURRENCY - 1);
    for (const r of rejected) {
      expect(
        r.reason instanceof ApprovalAlreadyResolvedError ||
          r.reason instanceof PendingApprovalNotFoundError,
      ).toBe(true);
    }

    expect(await dualConfirmService.getPending(REQUEST_ID)).toBeUndefined();
    const approvals = (await testDb.db.select().from(auditLog)).filter(
      (r) => r.actionType === 'approval',
    );
    expect(approvals).toHaveLength(1);
  });

  it('dual-confirm: N SEGUNDAS aprobaciones concurrentes ejecutan una sola vez', async () => {
    const executor = vi.fn(async () => {
      await sleep(80);
      return 'borrado';
    });
    impl.deleteCalendarEventFuture = executor;
    await dualConfirmService.createPendingApproval({
      requestId: REQUEST_ID,
      toolName: 'deleteCalendarEventFuture',
      level: 'dual-confirm',
      inputsHash: 'h-dual',
      payload: { eventId: 'evt-1' },
    });
    // Primera aprobación ya dada hace >30 s: la segunda es válida.
    const longAgo = new Date(Date.now() - 60_000);
    await testDb.db
      .update(pendingApprovals)
      .set({
        firstApprovedAt: longAgo,
        firstApprover: 'owner',
        availableAt: new Date(longAgo.getTime() + 30_000),
      })
      .where(eq(pendingApprovals.requestId, REQUEST_ID));

    await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () =>
        service.resolveAndExecute(REQUEST_ID, 'owner'),
      ),
    );

    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('dual-confirm: dos PRIMERAS aprobaciones simultáneas no ejecutan nada ni saltean los 30 s', async () => {
    const executor = vi.fn().mockResolvedValue('no-deberia');
    impl.deleteCalendarEventFuture = executor;
    await dualConfirmService.createPendingApproval({
      requestId: REQUEST_ID,
      toolName: 'deleteCalendarEventFuture',
      level: 'dual-confirm',
      inputsHash: 'h-dual-2',
      payload: { eventId: 'evt-2' },
    });

    const settled = await Promise.allSettled([
      service.resolveAndExecute(REQUEST_ID, 'owner'),
      service.resolveAndExecute(REQUEST_ID, 'owner'),
    ]);

    // Ninguna de las dos puede contar como "segunda aprobación" dentro de
    // los 30 s: la que pierde la carrera recibe SecondApprovalTooEarlyError.
    expect(executor).not.toHaveBeenCalled();
    const rejected = settled.filter(
      (s): s is PromiseRejectedResult => s.status === 'rejected',
    );
    const fulfilled = settled.filter(
      (s): s is PromiseFulfilledResult<unknown> => s.status === 'fulfilled',
    );
    expect(
      rejected.every((r) => r.reason instanceof SecondApprovalTooEarlyError),
    ).toBe(true);
    expect(
      fulfilled.every(
        (f) => (f.value as { outcome?: string }).outcome === 'awaiting-second',
      ),
    ).toBe(true);
    expect(fulfilled.length).toBeGreaterThanOrEqual(1); // exactamente una gana
    const row = await dualConfirmService.getPending(REQUEST_ID);
    expect(row?.firstApprovedAt).not.toBeNull();
    expect(row?.executingAt ?? null).toBeNull();
  });

  it('si el executor FALLA: el error se propaga, el pendiente queda sin ejecutar y exige una nueva aprobación', async () => {
    const executor = vi
      .fn()
      .mockRejectedValueOnce(new Error('gmail 503'))
      .mockResolvedValueOnce('enviado-al-reintentar');
    impl.sendEmail = executor;
    await createConfirmPending();

    await expect(
      service.resolveAndExecute(REQUEST_ID, 'owner'),
    ).rejects.toThrow('gmail 503');

    // Sigue pendiente, liberado (no "ejecutando") y con el motivo guardado.
    const afterFailure = await dualConfirmService.getPending(REQUEST_ID);
    expect(afterFailure).toBeDefined();
    expect(afterFailure?.executingAt).toBeNull();
    expect(afterFailure?.executionError).toContain('gmail 503');

    // El audit conserva la intención (approved) Y el fallo.
    const rows = await testDb.db.select().from(auditLog);
    expect(rows.some((r) => r.actionType === 'approval')).toBe(true);
    expect(rows.some((r) => r.actionType === 'execution_failed')).toBe(true);

    // NO hay reintento automático (regla de oro #9): una NUEVA aprobación humana sí ejecuta.
    expect(executor).toHaveBeenCalledTimes(1);
    const retry = await service.resolveAndExecute(REQUEST_ID, 'owner');
    expect(retry).toMatchObject({
      outcome: 'resolved',
      result: 'enviado-al-reintentar',
    });
    expect(executor).toHaveBeenCalledTimes(2);
    expect(await dualConfirmService.getPending(REQUEST_ID)).toBeUndefined();
  });

  it('fail-closed: si el AUDIT falla, la acción NO se ejecuta y el pendiente queda liberado', async () => {
    const executor = vi.fn().mockResolvedValue('no-deberia-ejecutarse');
    impl.sendEmail = executor;
    await createConfirmPending();
    vi.spyOn(auditService, 'recordApproval').mockRejectedValueOnce(
      new Error('audit chain bloqueada'),
    );

    await expect(
      service.resolveAndExecute(REQUEST_ID, 'owner'),
    ).rejects.toThrow('audit chain bloqueada');

    expect(executor).not.toHaveBeenCalled();
    const row = await dualConfirmService.getPending(REQUEST_ID);
    expect(row).toBeDefined();
    expect(row?.executingAt).toBeNull();
  });

  it('un pendiente reclamado (ejecutándose) no puede rechazarse a mitad de la ejecución', async () => {
    const executor = vi.fn(async () => {
      await sleep(150);
      return 'ok';
    });
    impl.sendEmail = executor;
    await createConfirmPending();

    const inFlight = service.resolveAndExecute(REQUEST_ID, 'owner');
    await sleep(40); // ya reclamado, todavía ejecutando
    await expect(
      service.resolveRejection(REQUEST_ID, 'owner'),
    ).rejects.toBeInstanceOf(ApprovalAlreadyResolvedError);
    await inFlight;
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
