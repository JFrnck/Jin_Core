import { randomUUID } from 'node:crypto';
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
import {
  GithubExecutorClient,
  type GithubBranches,
  type GithubCloneResult,
  type GithubPushResult,
  type GithubRepo,
  type GithubRepoStatus,
} from './github-executor.client';

export const PUSH_TOOL_NAME = 'pushGithubBranch';
const OWNER_ACTOR = 'owner:api';

export type PushOutcome =
  | { readonly status: 'pending-approval'; readonly requestId: string }
  | {
      readonly status: 'pushed';
      readonly requestId: string;
      readonly result: GithubPushResult;
    };

/** Lo que se persiste y se hashea de un push: sin contenido de archivos, solo qué y adónde. */
interface PushPayload {
  readonly workspaceId: string;
  readonly dir: string;
  readonly branch: string;
  readonly message: string;
  readonly repo: string;
  readonly files: number;
}

/**
 * GitHub desde la app del owner (ADR 0022), sin pasar por el modelo. Leer y clonar repos TUYOS, ver el
 * estado, cambiar de rama y actualizar son acciones del owner sobre su propio dato: `auto` + audit (como
 * `exportPreviewFiles`). **Subir cambios** sale a un servicio externo: pasa por `HitlPolicyService` igual
 * que cualquier otra tool (`confirm`, `humanDecision`: ningún modo de autonomía lo relaja) y deja una
 * aprobación pendiente. El token vive solo en el Executor.
 */
@Injectable()
export class OwnerGithubService {
  constructor(
    private readonly client: GithubExecutorClient,
    private readonly hitlPolicyService: HitlPolicyService,
    private readonly dualConfirmService: DualConfirmService,
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async repos(): Promise<readonly GithubRepo[]> {
    return this.client.repos();
  }

  async clone(
    workspaceId: string,
    body: { repo: string; ref?: string | undefined; dir?: string | undefined },
  ): Promise<GithubCloneResult> {
    await this.audit(
      'githubCloneRepo',
      { workspaceId, ...body },
      `Clonar «${body.repo}»${body.ref ? ` (${body.ref})` : ''} en el proyecto ${workspaceId} (${body.dir ?? '.'})`,
    );
    return this.client.clone(workspaceId, body);
  }

  status(workspaceId: string, dir?: string): Promise<GithubRepoStatus> {
    return this.client.status(workspaceId, dir);
  }

  branches(workspaceId: string, dir?: string): Promise<GithubBranches> {
    return this.client.branches(workspaceId, dir);
  }

  async checkout(
    workspaceId: string,
    body: {
      dir?: string | undefined;
      branch: string;
      create?: boolean | undefined;
    },
  ) {
    await this.audit(
      'githubCheckout',
      { workspaceId, ...body },
      `${body.create ? 'Crear y cambiar a' : 'Cambiar a'} la rama «${body.branch}» del proyecto ${workspaceId}`,
    );
    return this.client.checkout(workspaceId, body);
  }

  async pull(workspaceId: string, body: { dir?: string | undefined }) {
    await this.audit(
      'githubPull',
      { workspaceId, ...body },
      `Actualizar (pull, solo avance rápido) el proyecto ${workspaceId}`,
    );
    return this.client.pull(workspaceId, body);
  }

  /**
   * Pide subir los cambios a una rama. Antes consulta el estado (para decir QUÉ repo y cuántos archivos
   * en la aprobación) y no deja una aprobación si no hay nada que subir.
   */
  async requestPush(
    workspaceId: string,
    body: { dir?: string | undefined; branch: string; message: string },
  ): Promise<PushOutcome> {
    const status = await this.client.status(workspaceId, body.dir);
    if (status.clean)
      throw new BadRequestException('No hay cambios que subir.');
    const payload: PushPayload = {
      workspaceId,
      dir: body.dir ?? '.',
      branch: body.branch,
      message: body.message,
      repo: status.repo,
      files: status.changed.length,
    };

    const decision = await this.hitlPolicyService.decide(
      PUSH_TOOL_NAME,
      payload,
    );
    const inputsHash = computeInputsHash(payload);
    const planSummary = `Subir ${payload.files}${status.changedTruncated ? '+' : ''} archivo${payload.files === 1 ? '' : 's'} cambiado${payload.files === 1 ? '' : 's'} de «${payload.repo}» a la rama NUEVA «${payload.branch}» en GitHub (mensaje: «${payload.message}»). Nunca va a main ni se fuerza.`;

    if (decision.level === 'confirm' || decision.level === 'dual-confirm') {
      await this.dualConfirmService.createPendingApproval({
        requestId: decision.requestId,
        toolName: PUSH_TOOL_NAME,
        level: decision.level,
        inputsHash,
        planSummary,
        payload,
        actor: OWNER_ACTOR,
      });
      return { status: 'pending-approval', requestId: decision.requestId };
    }

    const result = (await this.toolExecutorRegistry.execute(
      PUSH_TOOL_NAME,
      payload,
      {
        requestId: decision.requestId,
      },
    )) as GithubPushResult;
    await this.auditService.recordToolCall({
      requestId: decision.requestId,
      actor: OWNER_ACTOR,
      toolName: PUSH_TOOL_NAME,
      inputsHash,
      approvalStatus: decision.level === 'auto' ? 'auto' : 'notified',
      planSummary,
    });
    if (decision.level === 'notify') {
      this.eventEmitter.emit(HITL_ACTION_NOTIFIED_EVENT, {
        requestId: decision.requestId,
        toolName: PUSH_TOOL_NAME,
        actor: OWNER_ACTOR,
        ...(decision.relaxedBy !== undefined
          ? { relaxedBy: decision.relaxedBy }
          : {}),
      } satisfies HitlActionNotifiedEvent);
    }
    return { status: 'pushed', requestId: decision.requestId, result };
  }

  /** Lo que ejecuta la aprobación: el payload viene del registro de aprobaciones, no del modelo. */
  async executePush(payload: unknown): Promise<GithubPushResult> {
    const { workspaceId, dir, branch, message } = payload as PushPayload;
    return this.client.push(workspaceId, { dir, branch, message });
  }

  private async audit(
    toolName: string,
    inputs: unknown,
    planSummary: string,
  ): Promise<void> {
    await this.auditService.recordToolCall({
      requestId: randomUUID(),
      actor: OWNER_ACTOR,
      toolName,
      inputsHash: computeInputsHash(inputs),
      planSummary,
      approvalStatus: 'auto',
    });
  }
}
