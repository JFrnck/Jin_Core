import type { EventEmitter2 } from '@nestjs/event-emitter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUDGET_THRESHOLD_CROSSED_EVENT,
  BudgetAlertMonitor,
  KILL_SWITCH_ACTIVATED_EVENT,
} from './budget-alert.monitor';
import type { BudgetService } from './budget.service';
import type {
  KillSwitchService,
  KillSwitchStatus,
} from './kill-switch.service';

function status(active: boolean): KillSwitchStatus {
  return {
    active,
    activatedAt: active ? '2026-09-26T12:20:00.000Z' : null,
    reason: active ? 'runaway' : null,
    currentHourTokens: 0,
    avgHourlyTokens: 0,
  };
}

describe('BudgetAlertMonitor', () => {
  let ratio: number;
  let active: boolean;
  let emit: ReturnType<typeof vi.fn>;
  let monitor: BudgetAlertMonitor;

  beforeEach(() => {
    ratio = 0;
    active = false;
    emit = vi.fn();
    monitor = new BudgetAlertMonitor(
      {
        getDailyUsageRatio: vi.fn(() => Promise.resolve(ratio)),
      } as unknown as BudgetService,
      {
        getStatus: vi.fn(() => Promise.resolve(status(active))),
      } as unknown as KillSwitchService,
      { emit } as unknown as EventEmitter2,
    );
  });

  it('emite el kill switch solo en el flanco inactivo → activo', async () => {
    await monitor.check();
    active = true;
    await monitor.check();
    await monitor.check();
    active = false;
    await monitor.check();
    active = true;
    await monitor.check();

    const kills = emit.mock.calls.filter(
      ([name]) => name === KILL_SWITCH_ACTIVATED_EVENT,
    );
    expect(kills).toHaveLength(2);
    expect(kills[0]?.[1]).toEqual({
      reason: 'runaway',
      activatedAt: new Date('2026-09-26T12:20:00.000Z'),
    });
  });

  it('emite cada umbral (80 % y 100 %) una sola vez por día', async () => {
    ratio = 0.85;
    await monitor.check();
    await monitor.check();
    ratio = 1.02;
    await monitor.check();

    const crossed = emit.mock.calls
      .filter(([name]) => name === BUDGET_THRESHOLD_CROSSED_EVENT)
      .map(([, event]) => (event as { threshold: number }).threshold);
    expect(crossed).toEqual([0.8, 1]);
  });

  it('un error de la base no tumba el cron', async () => {
    monitor = new BudgetAlertMonitor(
      { getDailyUsageRatio: vi.fn() } as unknown as BudgetService,
      {
        getStatus: vi.fn(() => Promise.reject(new Error('db caída'))),
      } as unknown as KillSwitchService,
      { emit } as unknown as EventEmitter2,
    );
    await expect(monitor.check()).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });
});
