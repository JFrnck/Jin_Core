import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import { BudgetController } from './budget.controller';
import type { BudgetService } from './budget.service';
import type { KillSwitchService } from './kill-switch.service';

function buildController(overrides?: {
  budget?: Partial<BudgetService>;
  killSwitch?: Partial<KillSwitchService>;
  audit?: Partial<AuditService>;
}): BudgetController {
  const budget: Partial<BudgetService> = {
    getDailyUsageRatio: vi.fn().mockResolvedValue(0.5),
    getDailyUsage: vi
      .fn()
      .mockResolvedValue({ inputTokens: 0, outputTokens: 0, costUsd: 0 }),
    getLimits: vi
      .fn()
      .mockReturnValue({ dailyMaxTokens: 5_000_000, dailyMaxUsd: 10 }),
    ...overrides?.budget,
  };
  const killSwitch: Partial<KillSwitchService> = {
    isActive: vi.fn().mockResolvedValue(false),
    getStatus: vi.fn().mockResolvedValue({
      active: false,
      activatedAt: null,
      reason: null,
      currentHourTokens: 0,
      avgHourlyTokens: 0,
    }),
    unpause: vi.fn().mockResolvedValue(undefined),
    ...overrides?.killSwitch,
  };
  const audit: Partial<AuditService> = {
    recordApproval: vi.fn().mockResolvedValue(undefined),
    ...overrides?.audit,
  };
  return new BudgetController(
    budget as BudgetService,
    killSwitch as KillSwitchService,
    audit as AuditService,
  );
}

describe('BudgetController', () => {
  it('getStatus combina BudgetService y KillSwitchService', async () => {
    const controller = buildController({
      budget: {
        getDailyUsageRatio: vi.fn().mockResolvedValue(0.42),
        getDailyUsage: vi.fn().mockResolvedValue({
          inputTokens: 600_000,
          outputTokens: 242_340,
          costUsd: 4.31,
        }),
        getLimits: vi
          .fn()
          .mockReturnValue({ dailyMaxTokens: 1_000_000, dailyMaxUsd: 5 }),
      },
      killSwitch: {
        isActive: vi.fn().mockResolvedValue(true),
        getStatus: vi.fn().mockResolvedValue({
          active: true,
          activatedAt: '2026-08-03T23:14:52.000Z',
          reason: 'Consumo de la hora actual supera 2x el promedio.',
          currentHourTokens: 10_000,
          avgHourlyTokens: 4_166.67,
        }),
      },
    });

    await expect(controller.getStatus()).resolves.toEqual({
      dailyUsageRatio: 0.42,
      dailyUsageUsd: 4.31,
      dailyUsageTokens: 842_340,
      dailyLimitUsd: 5,
      dailyLimitTokens: 1_000_000,
      killSwitchActive: true,
      killSwitch: {
        activatedAt: '2026-08-03T23:14:52.000Z',
        reason: 'Consumo de la hora actual supera 2x el promedio.',
        currentHourTokens: 10_000,
        avgHourlyTokens: 4_166.67,
      },
    });
  });

  it('unpause desactiva el kill switch y audita con approver "owner", igual que Telegram', async () => {
    const unpause = vi.fn().mockResolvedValue(undefined);
    const recordApproval = vi.fn().mockResolvedValue(undefined);
    const controller = buildController({
      killSwitch: { unpause },
      audit: { recordApproval },
    });

    const result = await controller.unpause();

    expect(unpause).toHaveBeenCalled();
    expect(recordApproval).toHaveBeenCalledWith(
      expect.objectContaining({ approver: 'owner', toolName: 'unpause' }),
    );
    expect(result).toEqual({ ok: true });
  });
});
