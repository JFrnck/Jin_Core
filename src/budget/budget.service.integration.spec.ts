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
import type { ModelPrices } from '../model-provider/model-provider.types';
import {
  startTestDb,
  type TestDb,
} from '../../test/support/postgres-testcontainer';
import { DB_CONNECTION } from '../db/db.module';
import { budgetDailyUsage, budgetHourlyUsage } from '../db/schema';
import {
  BUDGET_REMAINING_RATIO,
  TOKENS_CONSUMED_TOTAL,
} from '../metrics/metrics.module';
import { BudgetService } from './budget.service';
import { BUDGET_CONFIG, MODEL_PRICES } from './budget.tokens';
import type { BudgetConfig } from './budget.types';
import { DailyBudgetExceededError, SessionBudgetExceededError } from './errors';

const TEST_CONFIG: BudgetConfig = {
  sessionMaxInputTokens: 1000,
  sessionMaxOutputTokens: 500,
  dailyMaxTokens: 10_000,
  dailyMaxUsd: 1,
  runawayMultiplier: 2,
  runawayLookbackHours: 24,
  runawayMinHourlyTokens: 100,
};

const TEST_PRICES: ModelPrices = {
  'test-model': { inputPerMillion: 100, outputPerMillion: 100 },
};

// No se testea el contenido de las métricas acá (eso es responsabilidad
// de Prometheus/prom-client) — solo se satisface la inyección para que
// BudgetService se pueda instanciar en la suite de integración.
const TEST_METRIC_PROVIDERS = [
  {
    provide: getToken(TOKENS_CONSUMED_TOTAL),
    useValue: { inc: vi.fn() },
  },
  {
    provide: getToken(BUDGET_REMAINING_RATIO),
    useValue: { set: vi.fn() },
  },
];

describe('BudgetService (integración, Postgres real)', () => {
  let testDb: TestDb;
  let service: BudgetService;

  beforeAll(async () => {
    testDb = await startTestDb();
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetService,
        { provide: DB_CONNECTION, useValue: testDb.db },
        { provide: BUDGET_CONFIG, useValue: TEST_CONFIG },
        { provide: MODEL_PRICES, useValue: TEST_PRICES },
        ...TEST_METRIC_PROVIDERS,
      ],
    }).compile();
    service = moduleRef.get(BudgetService);
  }, 30_000);

  afterAll(async () => {
    await testDb.stop();
  });

  beforeEach(async () => {
    await testDb.db.delete(budgetDailyUsage);
    await testDb.db.delete(budgetHourlyUsage);
  });

  it('checkBeforeCall sin uso previo devuelve budgetRemaining=1', async () => {
    const result = await service.checkBeforeCall({
      sessionId: 'sess-1',
      estimatedInputTokens: 10,
      maxOutputTokens: 10,
    });
    expect(result.budgetRemaining).toBe(1);
  });

  it('recordUsage persiste en budget_daily_usage y budget_hourly_usage', async () => {
    await service.recordUsage({
      sessionId: 'sess-1',
      modelId: 'test-model',
      taskProfile: 'test_profile',
      inputTokens: 1000,
      outputTokens: 500,
    });

    const [dailyRow] = await testDb.db.select().from(budgetDailyUsage);
    expect(dailyRow?.inputTokens).toBe(1000);
    expect(dailyRow?.outputTokens).toBe(500);
    // (1000+500)/1M tokens * $100/M = $0.15
    expect(dailyRow?.costUsd).toBeCloseTo(0.15, 6);

    const [hourlyRow] = await testDb.db.select().from(budgetHourlyUsage);
    expect(hourlyRow?.inputTokens).toBe(1000);
  });

  it('getSessionUsage: 0/0 para una sesión que nunca registró uso (Fase 5.4, ADR 0005)', () => {
    expect(service.getSessionUsage('sesion-inexistente')).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('getSessionUsage: refleja el acumulado en memoria de recordUsage — lo que suma el orquestador multi-agente', async () => {
    await service.recordUsage({
      sessionId: 'run-1:ticket-a',
      modelId: 'test-model',
      taskProfile: 'test_profile',
      inputTokens: 100,
      outputTokens: 50,
    });
    await service.recordUsage({
      sessionId: 'run-1:ticket-a',
      modelId: 'test-model',
      taskProfile: 'test_profile',
      inputTokens: 30,
      outputTokens: 20,
    });

    expect(service.getSessionUsage('run-1:ticket-a')).toEqual({
      inputTokens: 130,
      outputTokens: 70,
    });
    // Otra sesión no se ve afectada — cada sub-agente tiene su propio techo.
    expect(service.getSessionUsage('run-1:ticket-b')).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('recordUsage acumula (no reemplaza) llamadas sucesivas el mismo día/hora', async () => {
    await service.recordUsage({
      sessionId: 'sess-1',
      modelId: 'test-model',
      taskProfile: 'test_profile',
      inputTokens: 100,
      outputTokens: 100,
    });
    await service.recordUsage({
      sessionId: 'sess-1',
      modelId: 'test-model',
      taskProfile: 'test_profile',
      inputTokens: 200,
      outputTokens: 200,
    });

    const [dailyRow] = await testDb.db.select().from(budgetDailyUsage);
    expect(dailyRow?.inputTokens).toBe(300);
    expect(dailyRow?.outputTokens).toBe(300);
  });

  it('escrituras concurrentes de recordUsage no pierden incrementos (upsert atómico)', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        service.recordUsage({
          sessionId: `sess-concurrent-${i}`,
          modelId: 'test-model',
          taskProfile: 'test_profile',
          inputTokens: 10,
          outputTokens: 10,
        }),
      ),
    );

    const [dailyRow] = await testDb.db.select().from(budgetDailyUsage);
    expect(dailyRow?.inputTokens).toBe(100);
    expect(dailyRow?.outputTokens).toBe(100);
  });

  it('checkBeforeCall lanza SessionBudgetExceededError si la sesión ya acumuló cerca del límite', async () => {
    await service.recordUsage({
      sessionId: 'sess-full',
      modelId: 'test-model',
      taskProfile: 'test_profile',
      inputTokens: 950,
      outputTokens: 0,
    });

    await expect(
      service.checkBeforeCall({
        sessionId: 'sess-full',
        estimatedInputTokens: 100, // 950 + 100 > 1000 (sessionMaxInputTokens)
        maxOutputTokens: 10,
      }),
    ).rejects.toThrow(SessionBudgetExceededError);
  });

  it('checkBeforeCall lanza DailyBudgetExceededError al llegar al 100% del daily', async () => {
    await service.recordUsage({
      sessionId: 'sess-a',
      modelId: 'test-model',
      taskProfile: 'test_profile',
      inputTokens: 10_000, // = dailyMaxTokens exacto
      outputTokens: 0,
    });

    await expect(
      service.checkBeforeCall({
        sessionId: 'sess-b',
        estimatedInputTokens: 1,
        maxOutputTokens: 1,
      }),
    ).rejects.toThrow(DailyBudgetExceededError);
  });

  it('getDailyUsageRatio refleja el consumo persistido incluso desde una instancia nueva del servicio (sobrevive a un "restart")', async () => {
    await service.recordUsage({
      sessionId: 'sess-1',
      modelId: 'test-model',
      taskProfile: 'test_profile',
      inputTokens: 8000, // 80% de dailyMaxTokens
      outputTokens: 0,
    });

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        BudgetService,
        { provide: DB_CONNECTION, useValue: testDb.db },
        { provide: BUDGET_CONFIG, useValue: TEST_CONFIG },
        { provide: MODEL_PRICES, useValue: TEST_PRICES },
        ...TEST_METRIC_PROVIDERS,
      ],
    }).compile();
    const freshService = moduleRef.get(BudgetService);

    const ratio = await freshService.getDailyUsageRatio();
    expect(ratio).toBeCloseTo(0.8, 6);
  });

  it('getDailyUsage() devuelve el desglose real (tokens + costo), no solo el ratio', async () => {
    await service.recordUsage({
      sessionId: 'sess-1',
      modelId: 'test-model',
      taskProfile: 'test_profile',
      inputTokens: 1000,
      outputTokens: 500,
    });

    const usage = await service.getDailyUsage();

    expect(usage.inputTokens).toBe(1000);
    expect(usage.outputTokens).toBe(500);
    expect(usage.costUsd).toBeGreaterThan(0);
  });

  it('getLimits() expone los límites diarios configurados, no un ratio calculado', () => {
    expect(service.getLimits()).toEqual({
      dailyMaxTokens: TEST_CONFIG.dailyMaxTokens,
      dailyMaxUsd: TEST_CONFIG.dailyMaxUsd,
    });
  });

  it('hour_bucket trunca correctamente a la hora (no crea una fila por minuto)', async () => {
    await service.recordUsage({
      sessionId: 'sess-1',
      modelId: 'test-model',
      taskProfile: 'test_profile',
      inputTokens: 10,
      outputTokens: 10,
    });
    await service.recordUsage({
      sessionId: 'sess-1',
      modelId: 'test-model',
      taskProfile: 'test_profile',
      inputTokens: 10,
      outputTokens: 10,
    });

    const rows = await testDb.db.select().from(budgetHourlyUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.inputTokens).toBe(20);
  });
});
