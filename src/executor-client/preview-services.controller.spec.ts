import { describe, expect, it, vi } from 'vitest';
import type {
  ExecutorClientService,
  PreviewServiceInfo,
} from './executor-client.service';
import { PreviewServicesController } from './preview-services.controller';

function buildController(
  overrides?: Partial<ExecutorClientService>,
): PreviewServicesController {
  const service: Partial<ExecutorClientService> = {
    listPreviewServices: vi.fn().mockResolvedValue([]),
    stopPreviewService: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return new PreviewServicesController(service as ExecutorClientService);
}

describe('PreviewServicesController', () => {
  it('list delega en ExecutorClientService.listPreviewServices y devuelve un array mutable', async () => {
    const info: PreviewServiceInfo = {
      id: 'svc-1',
      slug: 'tesis-dashboard-a7f3k9',
      url: 'https://tesis-dashboard-a7f3k9.jinserver.com',
      status: 'running',
      expiresAt: '2026-08-04T08:52:00.000Z',
    };
    const listPreviewServices = vi
      .fn()
      .mockResolvedValue(Object.freeze([info]));
    const controller = buildController({ listPreviewServices });

    await expect(controller.list()).resolves.toEqual([info]);
    expect(listPreviewServices).toHaveBeenCalled();
  });

  it('stop delega en ExecutorClientService.stopPreviewService con el serviceId', async () => {
    const stopPreviewService = vi.fn().mockResolvedValue(undefined);
    const controller = buildController({ stopPreviewService });

    await expect(controller.stop('svc-1')).resolves.toEqual({ ok: true });
    expect(stopPreviewService).toHaveBeenCalledWith('svc-1');
  });
});
