import { Test, type TestingModule } from '@nestjs/testing';
import { getToken } from '@willsoto/nestjs-prometheus';
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
import { DB_CONNECTION } from '../db/db.module';
import { budgetHourlyUsage, budgetKillSwitch } from '../db/schema';
import { RUNAWAY_DETECTED_TOTAL } from '../metrics/metrics.module';
import { currentHourBucket } from './budget-time';
import { BUDGET_CONFIG } from './budget.tokens';
import type { BudgetConfig } from './budget.types';
import { KillSwitchService } from './kill-switch.service';

const TEST_METRIC_PROVIDERS = [
  {
    provide: getToken(RUNAWAY_DETECTED_TOTAL),
    useValue: { inc: vi.fn() },
  },
];

const TEST_CONFIG: BudgetConfig = {
  sessionMaxInputTokens: 500_000,
  sessionMaxOutputTokens: 100_000,
  dailyMaxTokens: 5_000_000,
  dailyMaxUsd: 10,
  runawayMultiplier: 2,
  runawayLookbackHours: 3,
};

function hoursAgo(n: number): Date {
  const bucket = currentHourBucket();
  bucket.setHours(bucket.getHours() - n);
  return bucket;
}

describe('KillSwitchService (integración, Postgres real)', () => {
  let testDb: TestDb;
  let service: KillSwitchService;

  beforeAll(async () => {
    testDb = await startTestDb();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        KillSwitchService,
        { provide: DB_CONNECTION, useValue: testDb.db },
        { provide: BUDGET_CONFIG, useValue: TEST_CONFIG },
        ...TEST_METRIC_PROVIDERS,
      ],
    }).compile();
    service = moduleRef.get(KillSwitchService);
  }, 30_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.db.delete(budgetHourlyUsage);
    await testDb.db.delete(budgetKillSwitch);
  });

  it('isActive() es false sin ninguna fila de estado', async () => {
    expect(await service.isActive()).toBe(false);
  });

  it('checkRunaway no activa el kill switch con consumo normal', async () => {
    await testDb.db.insert(budgetHourlyUsage).values([
      {
        hourBucket: hoursAgo(1),
        inputTokens: 100,
        outputTokens: 0,
        costUsd: 0,
      },
      {
        hourBucket: hoursAgo(2),
        inputTokens: 100,
        outputTokens: 0,
        costUsd: 0,
      },
      {
        hourBucket: hoursAgo(3),
        inputTokens: 100,
        outputTokens: 0,
        costUsd: 0,
      },
      {
        hourBucket: currentHourBucket(),
        inputTokens: 100,
        outputTokens: 0,
        costUsd: 0,
      },
    ]);

    await service.checkRunaway();

    expect(await service.isActive()).toBe(false);
  });

  it('checkRunaway activa el kill switch ante un runaway real y persiste el estado', async () => {
    await testDb.db.insert(budgetHourlyUsage).values([
      {
        hourBucket: hoursAgo(1),
        inputTokens: 100,
        outputTokens: 0,
        costUsd: 0,
      },
      {
        hourBucket: hoursAgo(2),
        inputTokens: 100,
        outputTokens: 0,
        costUsd: 0,
      },
      {
        hourBucket: hoursAgo(3),
        inputTokens: 100,
        outputTokens: 0,
        costUsd: 0,
      },
      {
        hourBucket: currentHourBucket(),
        inputTokens: 10_000, // muy por encima de 2x el promedio de 100/h
        outputTokens: 0,
        costUsd: 0,
      },
    ]);

    await service.checkRunaway();

    expect(await service.isActive()).toBe(true);
  });

  it('checkRunaway no dispara sin historial de lookback (arranque en frío)', async () => {
    await testDb.db.insert(budgetHourlyUsage).values({
      hourBucket: currentHourBucket(),
      inputTokens: 999_999,
      outputTokens: 0,
      costUsd: 0,
    });

    await service.checkRunaway();

    expect(await service.isActive()).toBe(false);
  });

  it('unpause() desactiva y persiste el estado (sobrevive a una instancia nueva del servicio)', async () => {
    await testDb.db.insert(budgetHourlyUsage).values([
      {
        hourBucket: hoursAgo(1),
        inputTokens: 100,
        outputTokens: 0,
        costUsd: 0,
      },
      {
        hourBucket: currentHourBucket(),
        inputTokens: 10_000,
        outputTokens: 0,
        costUsd: 0,
      },
    ]);
    await service.checkRunaway();
    expect(await service.isActive()).toBe(true);

    await service.unpause();

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        KillSwitchService,
        { provide: DB_CONNECTION, useValue: testDb.db },
        { provide: BUDGET_CONFIG, useValue: TEST_CONFIG },
        ...TEST_METRIC_PROVIDERS,
      ],
    }).compile();
    const freshService = moduleRef.get(KillSwitchService);

    expect(await freshService.isActive()).toBe(false);
  });

  it('getStatus() sin ninguna fila devuelve inactivo y sin actividad de hora', async () => {
    await expect(service.getStatus()).resolves.toEqual({
      active: false,
      activatedAt: null,
      reason: null,
      currentHourTokens: 0,
      avgHourlyTokens: 0,
    });
  });

  it('getStatus() expone el detalle real que explicó una activación (Fase 6.2, panel de presupuesto)', async () => {
    await testDb.db.insert(budgetHourlyUsage).values([
      {
        hourBucket: hoursAgo(1),
        inputTokens: 100,
        outputTokens: 0,
        costUsd: 0,
      },
      {
        hourBucket: hoursAgo(2),
        inputTokens: 100,
        outputTokens: 0,
        costUsd: 0,
      },
      {
        hourBucket: hoursAgo(3),
        inputTokens: 100,
        outputTokens: 0,
        costUsd: 0,
      },
      {
        hourBucket: currentHourBucket(),
        inputTokens: 10_000,
        outputTokens: 0,
        costUsd: 0,
      },
    ]);

    await service.checkRunaway();
    const status = await service.getStatus();

    expect(status.active).toBe(true);
    expect(status.activatedAt).not.toBeNull();
    expect(status.reason).toContain('supera');
    expect(status.currentHourTokens).toBe(10_000);
    expect(status.avgHourlyTokens).toBeCloseTo(100, 6);
  });

  it('checkRunaway no re-evalúa (ni sobreescribe la razón) si el kill switch ya está activo', async () => {
    await testDb.db.insert(budgetKillSwitch).values({
      id: 1,
      active: true,
      activatedAt: new Date('2026-01-01T00:00:00Z'),
      reason: 'razón original',
    });

    await service.checkRunaway();

    const [row] = await testDb.db.select().from(budgetKillSwitch);
    expect(row?.reason).toBe('razón original');
  });
});
