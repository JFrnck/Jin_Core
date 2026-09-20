import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
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
import { auditLog, autonomyModeState, pendingApprovals } from '../db/schema';
import { ApprovalExecutionService } from '../hitl/approval-execution.service';
import { DualConfirmService } from '../hitl/dual-confirm.service';
import type { HitlDecision } from '../hitl/types';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import type { AutonomyConfig } from './autonomy-config.schema';
import { AUTONOMY_MODE_CHANGED_EVENT } from './autonomy.events';
import {
  AUTONOMY_MODE_CHANGE_TOOL_NAME,
  AutonomyService,
} from './autonomy.service';
import { AUTONOMY_CONFIG } from './autonomy.tokens';

const CONFIG: AutonomyConfig = {
  semiAuto: { defaultHours: 24, maxHours: 72 },
  auto: { defaultHours: 4, maxHours: 24 },
  maxRelaxedActionsPerHour: 3,
};

const confirmDecision: HitlDecision = {
  requestId: 'req-x',
  toolName: 'runCode',
  level: 'confirm',
  approvalsRequired: 1,
  notifyAfterExecution: false,
};

const HOUR = 60 * 60 * 1000;

describe('AutonomyService (integración, Postgres real, ADR 0010)', () => {
  let testDb: TestDb;
  let service: AutonomyService;
  let approvals: ApprovalExecutionService;
  let audit: AuditService;
  let emitter: EventEmitter2;
  let emitSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    testDb = await startTestDb();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        AutonomyService,
        ApprovalExecutionService,
        DualConfirmService,
        AuditService,
        ChainVerificationService,
        ToolExecutorRegistry,
        { provide: AUTONOMY_CONFIG, useValue: CONFIG },
        { provide: DB_CONNECTION, useValue: testDb.db },
      ],
    }).compile();
    await moduleRef.init(); // dispara onModuleInit: registra el ejecutor de aprobaciones
    service = moduleRef.get(AutonomyService);
    approvals = moduleRef.get(ApprovalExecutionService);
    audit = moduleRef.get(AuditService);
    emitter = moduleRef.get(EventEmitter2);
  }, 30_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    emitSpy = vi.spyOn(emitter, 'emit');
    await testDb.db.delete(pendingApprovals);
    await testDb.db.delete(auditLog);
    // El estado vuelve al default sembrado por la migración 0011.
    await testDb.db
      .update(autonomyModeState)
      .set({
        mode: 'supervised',
        expiresAt: null,
        setBy: 'system:default',
        approvalRequestId: null,
        relaxedCount: 0,
        windowStartedAt: new Date(),
      })
      .where(eq(autonomyModeState.id, 1));
  });

  async function forceMode(
    mode: 'semi-auto' | 'auto',
    expiresAt: Date | null,
  ): Promise<void> {
    await testDb.db
      .update(autonomyModeState)
      .set({ mode, expiresAt, setBy: 'test' })
      .where(eq(autonomyModeState.id, 1));
  }

  it('el default sembrado por la migración es SUPERVISED (HITL completo)', async () => {
    const state = await service.getState();
    expect(state.mode).toBe('supervised');
    const d = await service.describe();
    expect(d.mode).toBe('supervised');
    expect(d.guardedInSemiAuto.sort()).toEqual(
      ['deleteCalendarEventFuture', 'mergeAgentBranch', 'sendEmail'].sort(),
    );
  });

  it('la tabla es un singleton: no admite una segunda fila ni un modo inválido', async () => {
    await expect(
      testDb.db.insert(autonomyModeState).values({ id: 2 }),
    ).rejects.toThrow();
    await expect(
      testDb.db
        .update(autonomyModeState)
        .set({ mode: 'yolo' })
        .where(eq(autonomyModeState.id, 1)),
    ).rejects.toThrow();
  });

  it('bajar la protección NO se aplica: crea un pendiente dual-confirm y el modo sigue supervised', async () => {
    const result = await service.requestModeChange({
      mode: 'auto',
      hours: 2,
      requestedBy: 'owner:telegram',
    });

    expect(result).toMatchObject({
      status: 'pending-approval',
      mode: 'auto',
      hours: 2,
    });
    expect((await service.getState()).mode).toBe('supervised');

    const [pending] = await testDb.db.select().from(pendingApprovals);
    expect(pending?.toolName).toBe(AUTONOMY_MODE_CHANGE_TOOL_NAME);
    expect(pending?.level).toBe('dual-confirm');
    expect(pending?.actor).toBe('owner:telegram');
  });

  it('flujo completo: dos aprobaciones aplican el modo, con caducidad y audit', async () => {
    const result = await service.requestModeChange({
      mode: 'auto',
      requestedBy: 'owner:api',
    });
    if (result.status !== 'pending-approval')
      throw new Error('debía quedar pendiente');

    // Una sola aprobación no alcanza.
    const first = await approvals.resolveAndExecute(result.requestId, 'owner');
    expect(first).toEqual({ outcome: 'awaiting-second' });
    expect((await service.getState()).mode).toBe('supervised');

    const longAgo = new Date(Date.now() - 60_000);
    await testDb.db
      .update(pendingApprovals)
      .set({
        firstApprovedAt: longAgo,
        availableAt: new Date(longAgo.getTime() + 30_000),
      })
      .where(eq(pendingApprovals.requestId, result.requestId));
    await approvals.resolveAndExecute(result.requestId, 'owner');

    const state = await service.getState();
    expect(state.mode).toBe('auto');
    expect(state.setBy).toBe('owner:dual-confirm');
    // default de auto = 4 h
    const remaining = (state.expiresAt?.getTime() ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(3.9 * HOUR);
    expect(remaining).toBeLessThanOrEqual(4 * HOUR);

    const rows = await testDb.db.select().from(auditLog);
    expect(
      rows.some(
        (r) =>
          r.toolName === AUTONOMY_MODE_CHANGE_TOOL_NAME &&
          r.approvalStatus === 'approved',
      ),
    ).toBe(true);
    expect(
      rows.some(
        (r) =>
          r.toolName === AUTONOMY_MODE_CHANGE_TOOL_NAME &&
          r.approvalStatus === 'auto' &&
          (r.planSummary ?? '').includes('supervised -> auto'),
      ),
    ).toBe(true);
    expect(emitSpy).toHaveBeenCalledWith(
      AUTONOMY_MODE_CHANGED_EVENT,
      expect.objectContaining({
        mode: 'auto',
        previousMode: 'supervised',
        reason: 'approved',
      }),
    );
  });

  it('las horas pedidas se acotan al máximo de la config (auto: 24 h)', async () => {
    const result = await service.requestModeChange({
      mode: 'auto',
      hours: 999,
      requestedBy: 'owner:api',
    });
    expect(result).toMatchObject({ status: 'pending-approval', hours: 24 });
  });

  it('volver a supervised es INMEDIATO, sin aprobación, y queda auditado', async () => {
    await forceMode('auto', new Date(Date.now() + HOUR));

    const result = await service.requestModeChange({
      mode: 'supervised',
      requestedBy: 'owner:telegram',
    });

    expect(result).toEqual({
      status: 'applied',
      mode: 'supervised',
      expiresAt: null,
    });
    expect((await service.getState()).mode).toBe('supervised');
    expect(await testDb.db.select().from(pendingApprovals)).toHaveLength(0);
    const rows = await testDb.db.select().from(auditLog);
    expect(
      rows.some((r) => (r.planSummary ?? '').includes('auto -> supervised')),
    ).toBe(true);
  });

  it('pasar de auto a semi-auto (más restrictivo) es inmediato; renovar el mismo modo relajado exige dual-confirm', async () => {
    await forceMode('auto', new Date(Date.now() + HOUR));
    const down = await service.requestModeChange({
      mode: 'semi-auto',
      requestedBy: 'owner:api',
    });
    expect(down.status).toBe('applied');
    expect((await service.getState()).mode).toBe('semi-auto');

    const renew = await service.requestModeChange({
      mode: 'semi-auto',
      requestedBy: 'owner:api',
    });
    expect(renew.status).toBe('pending-approval');
  });

  it('un modo relajado CADUCADO se lee como supervised y el cron lo revierte, avisa y audita', async () => {
    await forceMode('auto', new Date(Date.now() - 1000));

    expect((await service.getState()).mode).toBe('supervised'); // lectura perezosa
    await service.expireIfNeeded();

    const [row] = await testDb.db.select().from(autonomyModeState);
    expect(row?.mode).toBe('supervised');
    expect(row?.setBy).toBe('system:expiry');
    expect(emitSpy).toHaveBeenCalledWith(
      AUTONOMY_MODE_CHANGED_EVENT,
      expect.objectContaining({ reason: 'expired', mode: 'supervised' }),
    );
  });

  it('fail-safe: un modo relajado SIN caducidad se trata como supervised', async () => {
    await forceMode('auto', null);
    expect((await service.getState()).mode).toBe('supervised');
  });

  it('relax() en modo auto: confirm -> notify con relaxedBy; dual-confirm intacto', async () => {
    await forceMode('auto', new Date(Date.now() + HOUR));

    const relaxed = await service.relax(confirmDecision, {});
    expect(relaxed).toMatchObject({
      level: 'notify',
      relaxedBy: 'autonomy:auto',
      approvalsRequired: 0,
    });

    const dual = await service.relax(
      { ...confirmDecision, level: 'dual-confirm', approvalsRequired: 2 },
      {},
    );
    expect(dual.level).toBe('dual-confirm');
    expect(dual.relaxedBy).toBeUndefined();
  });

  it('relax() en supervised no toca nada ni cuenta contra el freno', async () => {
    const out = await service.relax(confirmDecision, {});
    expect(out).toEqual(confirmDecision);
    const [row] = await testDb.db.select().from(autonomyModeState);
    expect(row?.relaxedCount).toBe(0);
  });

  it('FRENO DE EMERGENCIA: al superar el máximo por hora vuelve a supervised, avisa, y esa acción pide aprobación', async () => {
    await forceMode('auto', new Date(Date.now() + HOUR));

    const outs = [];
    for (let i = 0; i < CONFIG.maxRelaxedActionsPerHour; i++) {
      outs.push(await service.relax(confirmDecision, {}));
    }
    expect(outs.every((d) => d.level === 'notify')).toBe(true);
    expect((await service.getState()).mode).toBe('auto');

    const overflow = await service.relax(confirmDecision, {}); // la N+1
    expect(overflow.level).toBe('confirm'); // vuelve a pedir aprobación
    expect((await service.getState()).mode).toBe('supervised');
    expect(emitSpy).toHaveBeenCalledWith(
      AUTONOMY_MODE_CHANGED_EVENT,
      expect.objectContaining({
        reason: 'circuit-breaker',
        mode: 'supervised',
      }),
    );
  });

  it('el contador del freno es atómico: 10 relax() concurrentes no pierden cuentas', async () => {
    await forceMode('auto', new Date(Date.now() + HOUR));
    await Promise.all(
      Array.from({ length: 3 }, () => service.relax(confirmDecision, {})),
    );
    const [row] = await testDb.db.select().from(autonomyModeState);
    expect(row?.relaxedCount).toBe(3);
  });

  it('FAIL-CLOSED al bajar la protección: si el audit falla, el modo NO cambia', async () => {
    const result = await service.requestModeChange({
      mode: 'auto',
      requestedBy: 'owner:api',
    });
    if (result.status !== 'pending-approval')
      throw new Error('debía quedar pendiente');
    vi.spyOn(audit, 'recordToolCall').mockRejectedValueOnce(
      new Error('audit caído'),
    );
    const longAgo = new Date(Date.now() - 60_000);
    await testDb.db
      .update(pendingApprovals)
      .set({
        firstApprovedAt: longAgo,
        availableAt: new Date(longAgo.getTime() + 30_000),
      })
      .where(eq(pendingApprovals.requestId, result.requestId));

    await expect(
      approvals.resolveAndExecute(result.requestId, 'owner'),
    ).rejects.toThrow();

    expect((await service.getState()).mode).toBe('supervised');
  });

  it('volver al modo seguro se aplica AUNQUE el audit falle (subir protección nunca se bloquea)', async () => {
    await forceMode('auto', new Date(Date.now() + HOUR));
    vi.spyOn(audit, 'recordToolCall').mockRejectedValue(
      new Error('audit caído'),
    );

    const result = await service.requestModeChange({
      mode: 'supervised',
      requestedBy: 'owner:telegram',
    });

    expect(result.status).toBe('applied');
    expect((await service.getState()).mode).toBe('supervised');
  });

  it('applyApprovedChange rechaza un payload malformado', async () => {
    await expect(
      service.applyApprovedChange({ mode: 'auto' }),
    ).rejects.toThrow();
    await expect(
      service.applyApprovedChange({
        mode: 'root',
        hours: 1,
        approvalRequestId: '11111111-1111-4111-8111-111111111111',
      }),
    ).rejects.toThrow();
    expect((await service.getState()).mode).toBe('supervised');
  });
});
