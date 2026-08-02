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
    ...overrides?.budget,
  };
  const killSwitch: Partial<KillSwitchService> = {
    isActive: vi.fn().mockResolvedValue(false),
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
      budget: { getDailyUsageRatio: vi.fn().mockResolvedValue(0.42) },
      killSwitch: { isActive: vi.fn().mockResolvedValue(true) },
    });

    await expect(controller.getStatus()).resolves.toEqual({
      dailyUsageRatio: 0.42,
      killSwitchActive: true,
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
