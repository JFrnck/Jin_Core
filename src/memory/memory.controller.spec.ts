import { describe, expect, it, vi } from 'vitest';
import { MemoryController } from './memory.controller';
import type { MemoryService } from './memory.service';
import type { MemoryEntry } from './memory.types';

describe('MemoryController', () => {
  it('recall delega en MemoryService.recall con query/k/filters', async () => {
    const entries: MemoryEntry[] = [];
    const recall = vi.fn().mockResolvedValue(entries);
    const controller = new MemoryController({
      recall,
    } as unknown as MemoryService);

    await controller.recall({
      query: 'reunión de mañana',
      k: 5,
      filters: { tipo: 'hecho' },
    });

    expect(recall).toHaveBeenCalledWith('reunión de mañana', 5, {
      tipo: 'hecho',
    });
  });
});
