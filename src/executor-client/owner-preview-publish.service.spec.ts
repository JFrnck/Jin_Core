import { BadRequestException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service';
import type { DualConfirmService } from '../hitl/dual-confirm.service';
import { HITL_ACTION_NOTIFIED_EVENT } from '../hitl/notify.events';
import type { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import type { HitlDecision } from '../hitl/types';
import type { HitlPolicyService } from '../hitl-policy/hitl-policy.service';
import type { PreviewServiceInfo } from './executor-client.service';
import { OwnerPreviewPublishService } from './owner-preview-publish.service';

const INPUT = {
  template: 'static',
  files: { 'index.html': '<h1>hola</h1>' },
  ttlSeconds: 3600,
};

const SERVICE: PreviewServiceInfo = {
  id: 'svc-1',
  slug: 'demo-a1b2c3',
  url: 'https://demo-a1b2c3.jinserver.com',
  status: 'running',
  expiresAt: '2026-09-28T20:00:00.000Z',
};

function decision(over: Partial<HitlDecision> = {}): HitlDecision {
  return {
    requestId: 'req-1',
    toolName: 'startPreviewService',
    level: 'confirm',
    approvalsRequired: 1,
    notifyAfterExecution: false,
    ...over,
  };
}

describe('OwnerPreviewPublishService', () => {
  let decide: ReturnType<typeof vi.fn>;
  let createPendingApproval: ReturnType<typeof vi.fn>;
  let execute: ReturnType<typeof vi.fn>;
  let recordToolCall: ReturnType<typeof vi.fn>;
  let emit: ReturnType<typeof vi.fn>;
  let service: OwnerPreviewPublishService;

  beforeEach(() => {
    decide = vi.fn().mockResolvedValue(decision());
    createPendingApproval = vi.fn().mockResolvedValue(undefined);
    execute = vi.fn().mockResolvedValue(SERVICE);
    recordToolCall = vi.fn().mockResolvedValue({});
    emit = vi.fn();
    service = new OwnerPreviewPublishService(
      { decide } as unknown as HitlPolicyService,
      { createPendingApproval } as unknown as DualConfirmService,
      { execute } as unknown as ToolExecutorRegistry,
      { recordToolCall } as unknown as AuditService,
      { emit } as unknown as EventEmitter2,
    );
  });

  it('nivel confirm: deja una aprobación pendiente del owner y NO ejecuta nada', async () => {
    const result = await service.publish(INPUT);

    expect(result).toEqual({ status: 'pending-approval', requestId: 'req-1' });
    expect(decide).toHaveBeenCalledWith('startPreviewService', INPUT);
    expect(createPendingApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-1',
        toolName: 'startPreviewService',
        level: 'confirm',
        actor: 'owner:api',
        payload: INPUT,
      }),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('el resumen de la aprobación dice cuántos archivos y qué plantilla', async () => {
    await service.publish({
      ...INPUT,
      files: { 'index.html': 'a', 'app.js': 'b' },
    });
    const arg = createPendingApproval.mock.calls[0]?.[0] as {
      planSummary: string;
    };
    expect(arg.planSummary).toContain('2 archivos');
    expect(arg.planSummary).toContain('plantilla static');
  });

  it('un modo de autonomía la relajó a notify: ejecuta, deja el audit y avisa post-hoc', async () => {
    decide.mockResolvedValue(
      decision({
        level: 'notify',
        approvalsRequired: 0,
        notifyAfterExecution: true,
        relaxedBy: 'autonomy:semi-auto',
      }),
    );

    const result = await service.publish(INPUT);

    expect(result).toEqual({
      status: 'started',
      requestId: 'req-1',
      service: SERVICE,
    });
    // La aprobación/decisión viaja como contexto (enlace con el audit), no en el payload.
    expect(execute).toHaveBeenCalledWith('startPreviewService', INPUT, {
      requestId: 'req-1',
    });
    expect(createPendingApproval).not.toHaveBeenCalled();
    expect(recordToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'owner:api',
        approvalStatus: 'notified',
        planSummary: expect.stringContaining('autonomy:semi-auto') as string,
      }),
    );
    expect(emit).toHaveBeenCalledWith(
      HITL_ACTION_NOTIFIED_EVENT,
      expect.objectContaining({
        toolName: 'startPreviewService',
        relaxedBy: 'autonomy:semi-auto',
      }),
    );
  });

  it('un proyecto inválido falla ANTES de decidir o crear nada', async () => {
    await expect(
      service.publish({
        template: 'static',
        files: { 'app.js': 'x' },
        ttlSeconds: 60,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.publish({ files: {}, ttlSeconds: 60 }),
    ).rejects.toThrow(/template: "static"/);
    expect(decide).not.toHaveBeenCalled();
    expect(createPendingApproval).not.toHaveBeenCalled();
  });

  it('si el Executor falla (p. ej. límite de pods), el error llega y no queda un audit de éxito', async () => {
    decide.mockResolvedValue(
      decision({ level: 'notify', approvalsRequired: 0 }),
    );
    execute.mockRejectedValue(new Error('límite de 3 servicios concurrentes'));
    await expect(service.publish(INPUT)).rejects.toThrow(/límite/);
    expect(recordToolCall).not.toHaveBeenCalled();
  });
});
