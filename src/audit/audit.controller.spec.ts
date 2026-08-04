import { describe, expect, it, vi } from 'vitest';
import type { AuditLogRow } from '../db/schema';
import type { AuditService, ListRecentResult } from './audit.service';
import { AuditController } from './audit.controller';

describe('AuditController', () => {
  it('list delega en AuditService.listRecent con los query params ya validados', async () => {
    const result: ListRecentResult = { items: [], nextCursor: null };
    const listRecent = vi.fn().mockResolvedValue(result);
    const controller = new AuditController({
      listRecent,
    } as unknown as AuditService);

    // .toEqual, no .toBe: el controller ahora arma un objeto nuevo (mapea
    // `id: bigint → string` en cada item antes de responder — bigint no
    // es serializable por JSON nativo).
    await expect(
      controller.list({ limit: 50, cursor: undefined }),
    ).resolves.toEqual(result);
    expect(listRecent).toHaveBeenCalledWith({ limit: 50, cursor: undefined });
  });

  it('list convierte id (bigint) a string en cada item — bigint no es serializable por JSON nativo', async () => {
    const row = { id: 4192n, toolName: 'sendEmail' } as unknown as AuditLogRow;
    const listRecent = vi
      .fn()
      .mockResolvedValue({ items: [row], nextCursor: '4192' });
    const controller = new AuditController({
      listRecent,
    } as unknown as AuditService);

    const response = await controller.list({ limit: 50, cursor: undefined });

    expect(response.items[0]?.id).toBe('4192');
    expect(typeof response.items[0]?.id).toBe('string');
  });
});
