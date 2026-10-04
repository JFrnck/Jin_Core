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
import { EnvVaultService } from './env-vault.service';
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
  let vault: EnvVaultService;

  beforeEach(() => {
    decide = vi.fn().mockResolvedValue(decision());
    createPendingApproval = vi.fn().mockResolvedValue(undefined);
    execute = vi.fn().mockResolvedValue(SERVICE);
    recordToolCall = vi.fn().mockResolvedValue({});
    emit = vi.fn();
    vault = new EnvVaultService();
    service = new OwnerPreviewPublishService(
      { decide } as unknown as HitlPolicyService,
      { createPendingApproval } as unknown as DualConfirmService,
      { execute } as unknown as ToolExecutorRegistry,
      { recordToolCall } as unknown as AuditService,
      { emit } as unknown as EventEmitter2,
      vault,
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

  describe('variables de entorno (ADR 0020): los valores NO salen de la bóveda en memoria', () => {
    // Valores de ejemplo construidos en ejecución (nada con forma de credencial en el repo).
    const VALUE = `q${'4455667788'.repeat(3)}`;
    const NODE_INPUT = {
      template: 'node',
      files: { 'package.json': '{"scripts":{"start":"node s.js"}}' },
      ttlSeconds: 3600,
      env: { BREVO_API_KEY: VALUE, BREVO_SENDER_NAME: 'evento' },
    };

    it('confirm: el payload persistido, el hash y el resumen llevan SOLO nombres; los valores esperan en la bóveda', async () => {
      const result = await service.publish(NODE_INPUT);

      expect(result).toEqual({
        status: 'pending-approval',
        requestId: 'req-1',
      });
      const approval = createPendingApproval.mock.calls[0]?.[0] as {
        payload: Record<string, unknown>;
        planSummary: string;
        inputsHash: string;
      };
      expect(approval.payload).not.toHaveProperty('env');
      expect(approval.payload.envNames).toEqual([
        'BREVO_API_KEY',
        'BREVO_SENDER_NAME',
      ]);
      expect(JSON.stringify(approval)).not.toContain(VALUE);
      expect(approval.planSummary).toContain('2 variables de entorno');
      expect(approval.planSummary).toContain('BREVO_API_KEY');
      expect(approval.planSummary).toContain('valores ocultos');
      // La política decide sobre el input SIN valores.
      expect(JSON.stringify(decide.mock.calls)).not.toContain(VALUE);
      // Los valores existen UNA vez, en la bóveda, ligados a la aprobación.
      expect(vault.has('req-1')).toBe(true);
      expect(vault.take('req-1')).toEqual(NODE_INPUT.env);
    });

    it('nivel relajado (notify): ejecuta con el requestId, el audit NO lleva valores y la bóveda sigue ahí para el ejecutor', async () => {
      decide.mockResolvedValue(
        decision({
          level: 'notify',
          approvalsRequired: 0,
          notifyAfterExecution: true,
        }),
      );

      await service.publish(NODE_INPUT);

      const [, payload, context] = execute.mock.calls[0] as [
        string,
        Record<string, unknown>,
        { requestId: string },
      ];
      expect(payload).not.toHaveProperty('env');
      expect(payload.envNames).toEqual(['BREVO_API_KEY', 'BREVO_SENDER_NAME']);
      expect(context).toEqual({ requestId: 'req-1' });
      expect(JSON.stringify(recordToolCall.mock.calls)).not.toContain(VALUE);
      expect(JSON.stringify(emit.mock.calls)).not.toContain(VALUE);
      expect(vault.has('req-1')).toBe(true);
    });

    it('variables inválidas (nombre reservado o mal formado): 400 sin repetir el valor y NO se guarda nada', async () => {
      const error = await service
        .publish({ ...NODE_INPUT, env: { PORT: VALUE, malo: VALUE } })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toContain('PORT');
      expect((error as Error).message).not.toContain(VALUE);
      expect(createPendingApproval).not.toHaveBeenCalled();
      expect(vault.has('req-1')).toBe(false);
    });

    it('si crear la aprobación falla, los valores se descartan de la bóveda', async () => {
      createPendingApproval.mockRejectedValue(new Error('db caída'));

      await expect(service.publish(NODE_INPUT)).rejects.toThrow('db caída');

      expect(vault.has('req-1')).toBe(false);
    });

    it('sin variables: la bóveda no se toca y el payload no lleva envNames', async () => {
      await service.publish(INPUT);

      expect(vault.has('req-1')).toBe(false);
      const approval = createPendingApproval.mock.calls[0]?.[0] as {
        payload: Record<string, unknown>;
        planSummary: string;
      };
      expect(approval.payload).not.toHaveProperty('envNames');
      expect(approval.planSummary).not.toContain('variable');
    });
  });
});
