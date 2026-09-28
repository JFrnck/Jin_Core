import { BadRequestException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { computeInputsHash } from '../agent/agent.logic';
import { AuditService } from '../audit/audit.service';
import { DualConfirmService } from '../hitl/dual-confirm.service';
import {
  HITL_ACTION_NOTIFIED_EVENT,
  type HitlActionNotifiedEvent,
} from '../hitl/notify.events';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { HitlPolicyService } from '../hitl-policy/hitl-policy.service';
import type { PreviewServiceInfo } from './executor-client.service';
import {
  expandPreviewTemplate,
  PreviewTemplateInputError,
  type PreviewServiceToolInput,
} from './preview-template.logic';

const TOOL_NAME = 'startPreviewService';
const OWNER_ACTOR = 'owner:api';

export type OwnerPublishResult =
  | { readonly status: 'pending-approval'; readonly requestId: string }
  | {
      readonly status: 'started';
      readonly requestId: string;
      readonly service: PreviewServiceInfo;
    };

/**
 * El owner levanta una app de preview SIN pasar por el modelo (ADR 0015):
 * cuando el proveedor rechaza el pedido, el owner no queda bloqueado.
 *
 * NO es una excepción a HITL: la decisión del nivel sigue siendo la de
 * `HitlPolicyService` (nivel del registry → overrides de feature flags →
 * modo de autonomía), la MISMA puerta que usa `AgentService`. Cambia solo
 * quién inicia. Con `confirm` queda una aprobación pendiente (Telegram, web,
 * app y push la ven igual); si un modo de autonomía la relajó a `notify`, se
 * ejecuta y deja su fila en el audit, como cualquier otra acción relajada.
 */
@Injectable()
export class OwnerPreviewPublishService {
  constructor(
    private readonly hitlPolicyService: HitlPolicyService,
    private readonly dualConfirmService: DualConfirmService,
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async publish(input: PreviewServiceToolInput): Promise<OwnerPublishResult> {
    // Valida la forma ANTES de crear nada: un proyecto inválido no debe
    // dejar una aprobación pendiente que el owner tenga que rechazar.
    try {
      expandPreviewTemplate(input);
    } catch (err: unknown) {
      if (err instanceof PreviewTemplateInputError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    const decision = await this.hitlPolicyService.decide(TOOL_NAME, input);
    const inputsHash = computeInputsHash(input);
    const fileCount = Object.keys(input.files).length;

    if (decision.level === 'confirm' || decision.level === 'dual-confirm') {
      await this.dualConfirmService.createPendingApproval({
        requestId: decision.requestId,
        toolName: TOOL_NAME,
        level: decision.level,
        inputsHash,
        planSummary: `Publicar una app desde el editor del iPhone (${fileCount} archivo${fileCount === 1 ? '' : 's'}, ${describeTemplate(input)}): se expone en https://<slug>.jinserver.com.`,
        payload: input,
        actor: OWNER_ACTOR,
      });
      return { status: 'pending-approval', requestId: decision.requestId };
    }

    const service = (await this.toolExecutorRegistry.execute(TOOL_NAME, input, {
      requestId: decision.requestId,
    })) as PreviewServiceInfo;

    await this.auditService.recordToolCall({
      requestId: decision.requestId,
      actor: OWNER_ACTOR,
      toolName: TOOL_NAME,
      inputsHash,
      approvalStatus: decision.level === 'auto' ? 'auto' : 'notified',
      ...(decision.relaxedBy !== undefined
        ? {
            planSummary: `Autoejecutada sin aprobación (${decision.relaxedBy}): "${TOOL_NAME}" era confirm`,
          }
        : {}),
    });
    if (decision.level === 'notify') {
      this.eventEmitter.emit(HITL_ACTION_NOTIFIED_EVENT, {
        requestId: decision.requestId,
        toolName: TOOL_NAME,
        actor: OWNER_ACTOR,
        ...(decision.relaxedBy !== undefined
          ? { relaxedBy: decision.relaxedBy }
          : {}),
      } satisfies HitlActionNotifiedEvent);
    }
    return { status: 'started', requestId: decision.requestId, service };
  }
}

function describeTemplate(input: PreviewServiceToolInput): string {
  return input.template === 'static'
    ? 'plantilla static'
    : `comando ${input.command?.join(' ') ?? '?'}`;
}
