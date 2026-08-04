import { describe, expect, it, vi } from 'vitest';
import type { PendingApprovalRow } from '../db/schema';
import type { ApprovalExecutionService } from './approval-execution.service';
import type { DualConfirmService } from './dual-confirm.service';
import { HitlController } from './hitl.controller';

function buildController(overrides?: {
  dualConfirm?: Partial<DualConfirmService>;
  approvalExecution?: Partial<ApprovalExecutionService>;
}): HitlController {
  const dualConfirm: Partial<DualConfirmService> = {
    listPending: vi.fn().mockResolvedValue([]),
    ...overrides?.dualConfirm,
  };
  const approvalExecution: Partial<ApprovalExecutionService> = {
    resolveAndExecute: vi.fn(),
    resolveRejection: vi.fn(),
    ...overrides?.approvalExecution,
  };
  return new HitlController(
    dualConfirm as DualConfirmService,
    approvalExecution as ApprovalExecutionService,
  );
}

describe('HitlController', () => {
  it('listPending delega en DualConfirmService.listPending()', async () => {
    const rows = [{ requestId: 'a' } as PendingApprovalRow];
    const controller = buildController({
      dualConfirm: { listPending: vi.fn().mockResolvedValue(rows) },
    });

    // .toEqual, no .toBe: el controller devuelve una copia superficial
    // (`[...rows]`) para satisfacer el array mutable que exige
    // `@ZodResponse([PendingApprovalDto])` en su firma de tipos.
    await expect(controller.listPending()).resolves.toEqual(rows);
  });

  it('approve delega en ApprovalExecutionService.resolveAndExecute con approver "owner"', async () => {
    const resolveAndExecute = vi
      .fn()
      .mockResolvedValue({ outcome: 'awaiting-second' });
    const controller = buildController({
      approvalExecution: { resolveAndExecute },
    });

    await controller.approve('req-1');

    expect(resolveAndExecute).toHaveBeenCalledWith('req-1', 'owner');
  });

  it('reject delega en ApprovalExecutionService.resolveRejection con approver "owner"', async () => {
    const resolveRejection = vi.fn().mockResolvedValue(undefined);
    const controller = buildController({
      approvalExecution: { resolveRejection },
    });

    const result = await controller.reject('req-1');

    expect(resolveRejection).toHaveBeenCalledWith('req-1', 'owner');
    expect(result).toEqual({ ok: true });
  });
});
