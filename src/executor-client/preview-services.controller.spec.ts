import { describe, expect, it, vi } from 'vitest';
import type {
  ExecutorClientService,
  PreviewServiceInfo,
} from './executor-client.service';
import type { AuditService } from '../audit/audit.service';
import type { OwnerPreviewPublishService } from './owner-preview-publish.service';
import { PreviewServicesController } from './preview-services.controller';

function buildController(
  overrides?: Partial<ExecutorClientService>,
  audit: Partial<AuditService> = { recordToolCall: vi.fn() },
): PreviewServicesController {
  const service: Partial<ExecutorClientService> = {
    listPreviewServices: vi.fn().mockResolvedValue([]),
    stopPreviewService: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return new PreviewServicesController(
    service as ExecutorClientService,
    {} as OwnerPreviewPublishService,
    audit as AuditService,
  );
}

describe('PreviewServicesController.exportFiles', () => {
  it('audita que el owner leyó el pod ANTES de pedirle los archivos al Executor', async () => {
    const order: string[] = [];
    const recordToolCall = vi.fn().mockImplementation(() => {
      order.push('audit');
      return Promise.resolve({});
    });
    const exportPreviewFiles = vi.fn().mockImplementation(() => {
      order.push('export');
      return Promise.resolve({
        files: { 'index.html': '<h1>x</h1>' },
        skipped: [{ path: 'node_modules/', reason: 'omitida' }],
      });
    });
    const controller = buildController(
      { exportPreviewFiles },
      { recordToolCall },
    );

    const result = await controller.exportFiles('svc-1', { dir: 'src' });

    expect(order).toEqual(['audit', 'export']);
    expect(recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'owner:api',
        toolName: 'exportPreviewFiles',
        approvalStatus: 'auto',
      }),
    );
    expect(exportPreviewFiles).toHaveBeenCalledWith('svc-1', 'src');
    expect(result.files).toEqual({ 'index.html': '<h1>x</h1>' });
    expect(result.skipped).toEqual([
      { path: 'node_modules/', reason: 'omitida' },
    ]);
  });

  it('fail-closed: si el audit falla no se lee el pod', async () => {
    const exportPreviewFiles = vi.fn();
    const controller = buildController(
      { exportPreviewFiles },
      { recordToolCall: vi.fn().mockRejectedValue(new Error('audit caído')) },
    );
    await expect(controller.exportFiles('svc-1', { dir: '.' })).rejects.toThrow(
      'audit caído',
    );
    expect(exportPreviewFiles).not.toHaveBeenCalled();
  });
});

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
