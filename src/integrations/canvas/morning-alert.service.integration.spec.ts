import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
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
} from '../../../test/support/postgres-testcontainer';
import { AuditService } from '../../audit/audit.service';
import { ChainVerificationService } from '../../audit/chain-verification.service';
import { DB_CONNECTION } from '../../db/db.module';
import { auditLog, shadowingRuns } from '../../db/schema';
import {
  MORNING_ALERT_EVENT,
  type MorningAlertEvent,
} from './morning-alert.events';
import { MAX_RUN_AGE_MS, MorningAlertService } from './morning-alert.service';

// Fase 9.4: Postgres real. Verifica la migración 0012 (tabla + CHECK) y los
// tres casos de la alerta: resumen real, corrida fallida y corrida ausente.
const NOW = new Date('2026-09-20T11:00:00.000Z'); // 06:00 en Lima
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('MorningAlertService (integración, Postgres real, Fase 9.4)', () => {
  let testDb: TestDb;
  let service: MorningAlertService;
  let auditService: AuditService;
  let emitted: MorningAlertEvent[];

  beforeAll(async () => {
    testDb = await startTestDb();
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        MorningAlertService,
        AuditService,
        ChainVerificationService,
        { provide: DB_CONNECTION, useValue: testDb.db },
      ],
    }).compile();
    service = moduleRef.get(MorningAlertService);
    auditService = moduleRef.get(AuditService);
    moduleRef
      .get(EventEmitter2)
      .on(MORNING_ALERT_EVENT, (e: MorningAlertEvent) => emitted.push(e));
  }, 30_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    emitted = [];
    await testDb.db.delete(shadowingRuns);
    await testDb.db.delete(auditLog);
  });

  it('corrida OK reciente: envía el resumen real', async () => {
    await testDb.db.insert(shadowingRuns).values({
      ranAt: hoursAgo(6),
      status: 'ok',
      summaryMarkdown: '- Lab 1 vence hoy',
    });

    const event = await service.run(NOW);

    expect(event.kind).toBe('summary');
    expect(emitted).toEqual([
      expect.objectContaining({
        kind: 'summary',
        summaryMarkdown: '- Lab 1 vence hoy',
      }),
    ]);
  });

  it('corrida FALLIDA: lo dice explícitamente con el motivo', async () => {
    await testDb.db.insert(shadowingRuns).values({
      ranAt: hoursAgo(6),
      status: 'failed',
      error: 'canvas 503',
    });

    const event = await service.run(NOW);

    expect(event).toMatchObject({ kind: 'failed', error: 'canvas 503' });
    expect(emitted).toHaveLength(1);
  });

  it('SIN corrida: dice que no se ejecutó (no un resumen vacío)', async () => {
    const event = await service.run(NOW);

    expect(event).toEqual({ kind: 'missing' });
    expect(emitted).toEqual([{ kind: 'missing' }]);
  });

  it('una corrida vieja (>12 h) no se presenta como la de anoche', async () => {
    await testDb.db.insert(shadowingRuns).values({
      ranAt: new Date(NOW.getTime() - MAX_RUN_AGE_MS - 60_000),
      status: 'ok',
      summaryMarkdown: 'resumen de anteayer',
    });

    expect((await service.run(NOW)).kind).toBe('missing');
  });

  it('usa la corrida MÁS RECIENTE si hay varias', async () => {
    await testDb.db.insert(shadowingRuns).values([
      { ranAt: hoursAgo(9), status: 'failed', error: 'vieja' },
      { ranAt: hoursAgo(6), status: 'ok', summaryMarkdown: 'nueva' },
    ]);

    expect(await service.run(NOW)).toMatchObject({
      kind: 'summary',
      summaryMarkdown: 'nueva',
    });
  });

  it('pasa por el audit log (auto, system_cron)', async () => {
    await service.run(NOW);

    const rows = await testDb.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: 'system_cron',
      toolName: 'morning_alert_cron',
      approvalStatus: 'auto',
    });
  });

  it('si el audit falla, la alerta IGUAL se envió y el cron no lanza', async () => {
    vi.spyOn(auditService, 'recordToolCall').mockRejectedValueOnce(
      new Error('cadena bloqueada'),
    );

    await expect(service.handleCron()).resolves.toBeUndefined();
    expect(emitted).toHaveLength(1);
  });

  it('la migración 0012 rechaza un status inválido (CHECK)', async () => {
    await expect(
      testDb.db.insert(shadowingRuns).values({ status: 'quizas' }),
    ).rejects.toThrow();
  });
});
