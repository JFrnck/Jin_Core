import { describe, expect, it, vi } from 'vitest';
import type { AuditService, ListRecentResult } from './audit.service';
import { AuditController } from './audit.controller';

describe('AuditController', () => {
  it('list delega en AuditService.listRecent con los query params ya validados', async () => {
    const result: ListRecentResult = { items: [], nextCursor: null };
    const listRecent = vi.fn().mockResolvedValue(result);
    const controller = new AuditController({
      listRecent,
    } as unknown as AuditService);

    await expect(
      controller.list({ limit: 50, cursor: undefined }),
    ).resolves.toBe(result);
    expect(listRecent).toHaveBeenCalledWith({ limit: 50, cursor: undefined });
  });
});
