import { randomUUID } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { computeInputsHash } from '../agent/agent.logic';
import { AuditService } from '../audit/audit.service';
import { DualConfirmService } from '../hitl/dual-confirm.service';
import {
  ToolExecutorRegistry,
  type ToolExecutionContext,
} from '../hitl/tool-executor.registry';
import { STATIC_SERVER_SOURCE } from '../executor-client/preview-template.logic';
import {
  AUDIT_COMMAND_PREVIEW_LENGTH,
  DELETE_TERMINAL_ENTRY_TOOL,
  DELETE_TERMINAL_WORKSPACE_TOOL,
  EXPOSE_TERMINAL_SESSION_TOOL,
  MAKE_TERMINAL_DIR_TOOL,
  RUN_TERMINAL_COMMAND_TOOL,
  START_TERMINAL_SESSION_TOOL,
  STOP_TERMINAL_SESSION_TOOL,
  TERMINAL_ACTOR,
  WRITE_TERMINAL_FILE_TOOL,
} from './terminal.constants';
import { TerminalUpstreamError } from './terminal.errors';
import {
  TerminalExecutorClient,
  type TerminalExportResult,
  type TerminalFsFile,
  type TerminalFsList,
  type TerminalFsWritten,
  type TerminalServiceInfo,
  type TerminalServiceStart,
  type TerminalWorkspaceInfo,
} from './terminal-executor.client';
import {
  ExposeApprovedPayloadSchema,
  StartTerminalApprovedPayloadSchema,
  TERMINAL_STATIC_PORT,
  type ExecTerminalInput,
  type ExposeTerminalInput,
  type FsWriteInput,
  type StartTerminalInput,
} from './terminal.schemas';

export interface PendingTerminalApproval {
  readonly status: 'pending-approval';
  readonly requestId: string;
}

function ttlLabel(seconds: number): string {
  const hours = seconds / 3600;
  return hours >= 1 && Number.isInteger(hours)
    ? `${hours} h`
    : `${Math.round(seconds / 60)} min`;
}

/**
 * La terminal del owner (ADR 0016 ampliada, 2026-09-28): hasta 10 proyectos
 * con disco propio (`workspaceId` = el id del proyecto en la app), de los
 * que solo 1-3 tienen un pod corriendo a la vez.
 *
 * - **Abrir o reanudar el pod de un workspace, y publicar un build** quedan
 *   como aprobaciones pendientes de nivel `confirm` FIJO (tools virtuales:
 *   el modelo no las ve y ningún modo de autonomía las relaja). Es lo que
 *   HITL vigila: crear un pod con salida a un registro y exponer un link
 *   público — el mismo riesgo exista o no ya el disco del proyecto.
 * - **Cada comando** que teclea el owner se audita ANTES de ejecutarse
 *   (fail-closed), pero no pide aprobación uno por uno.
 * - **Detener el pod y borrar el disco de un workspace** solo destruyen algo
 *   que ya es del owner (nada nuevo se crea, no hay egress nuevo): quedan
 *   en el audit, sin aprobación — igual que `stopPreviewService`.
 */
@Injectable()
export class OwnerTerminalService implements OnModuleInit {
  constructor(
    private readonly dualConfirmService: DualConfirmService,
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
    private readonly executor: TerminalExecutorClient,
    private readonly auditService: AuditService,
  ) {}

  onModuleInit(): void {
    this.toolExecutorRegistry.register(
      START_TERMINAL_SESSION_TOOL,
      (payload, context) => this.applyStart(payload, context),
    );
    this.toolExecutorRegistry.register(
      EXPOSE_TERMINAL_SESSION_TOOL,
      (payload) => this.applyExpose(payload),
    );
  }

  // ── Aprobaciones ───────────────────────────────────────────────────────

  async requestStart(
    workspaceId: string,
    input: StartTerminalInput,
  ): Promise<PendingTerminalApproval> {
    // Falla rápido: no vale la pena una aprobación si el Executor igual la rechazaría.
    const existing = (await this.executor.list()).find(
      (workspace) => workspace.id === workspaceId,
    );
    if (
      existing &&
      (existing.status === 'running' || existing.status === 'starting')
    ) {
      throw new TerminalUpstreamError(
        409,
        'Este proyecto ya tiene su terminal abierta.',
      );
    }

    const requestId = randomUUID();
    const fileCount = Object.keys(input.files).length;
    const payload = { workspaceId, ...input };
    await this.dualConfirmService.createPendingApproval({
      requestId,
      toolName: START_TERMINAL_SESSION_TOOL,
      level: 'confirm',
      inputsHash: computeInputsHash(payload),
      planSummary: existing
        ? `Reanudar la terminal de este proyecto por ${ttlLabel(input.ttlSeconds)}: el mismo disco, tal como quedó.`
        : `Abrir una terminal aislada para este proyecto por ${ttlLabel(input.ttlSeconds)} (${fileCount} archivo${fileCount === 1 ? '' : 's'} del editor): un pod sin más red que el proxy de npm del clúster. Los comandos los escribes tú.`,
      payload,
      actor: TERMINAL_ACTOR,
    });
    return { status: 'pending-approval', requestId };
  }

  async requestExpose(
    workspaceId: string,
    input: ExposeTerminalInput,
  ): Promise<PendingTerminalApproval> {
    const workspace = (await this.executor.list()).find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!workspace || workspace.status !== 'running') {
      throw new TerminalUpstreamError(
        404,
        'La terminal de ese proyecto no está corriendo.',
      );
    }
    if (workspace.exposure) {
      throw new TerminalUpstreamError(
        409,
        'Este proyecto ya publicó un build. Cierra la terminal para publicar otro.',
      );
    }

    const payload = { workspaceId, ...input };
    const requestId = randomUUID();
    await this.dualConfirmService.createPendingApproval({
      requestId,
      toolName: EXPOSE_TERMINAL_SESSION_TOOL,
      level: 'confirm',
      inputsHash: computeInputsHash(payload),
      planSummary: `Publicar el directorio "${input.dir}" de la terminal en https://<slug>.jinserver.com: un link público hasta que venza la sesión. Sirve los archivos tal cual con el servidor estático de Jin.`,
      payload,
      actor: TERMINAL_ACTOR,
    });
    return { status: 'pending-approval', requestId };
  }

  // ── Ejecutores de las aprobaciones (registrados en onModuleInit) ───────

  private applyStart(
    rawPayload: unknown,
    context?: ToolExecutionContext,
  ): Promise<TerminalWorkspaceInfo> {
    // Defensa en profundidad: se vuelve a validar lo que quedó guardado.
    const payload = StartTerminalApprovedPayloadSchema.parse(rawPayload);
    const { workspaceId, ...rest } = payload;
    // El id de la aprobación viene del contexto, no del payload guardado.
    return this.executor.start(workspaceId, {
      ...rest,
      requestId: context?.requestId,
    });
  }

  private applyExpose(
    rawPayload: unknown,
  ): Promise<{ slug: string; url: string }> {
    const payload = ExposeApprovedPayloadSchema.parse(rawPayload);
    return this.executor.expose(payload.workspaceId, {
      dir: payload.dir,
      slugHint: payload.slugHint,
      port: TERMINAL_STATIC_PORT,
      // Código fijo de Jin (el mismo de los previews), no del owner ni de un agente.
      serverSource: STATIC_SERVER_SOURCE,
    });
  }

  // ── Sin aprobación por operación ───────────────────────────────────────

  list(): Promise<readonly TerminalWorkspaceInfo[]> {
    return this.executor.list();
  }

  /** Detiene el pod del workspace; el disco NO se toca (se puede reanudar). */
  async stopPod(workspaceId: string): Promise<void> {
    await this.audit(
      STOP_TERMINAL_SESSION_TOOL,
      { workspaceId },
      'terminal: detener el pod (el disco se conserva)',
    );
    await this.executor.stopPod(workspaceId);
  }

  /** Borra el pod (si lo hay) Y el disco del workspace. Irreversible. */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.audit(
      DELETE_TERMINAL_WORKSPACE_TOOL,
      { workspaceId },
      'terminal: borrar el proyecto (pod y disco)',
    );
    await this.executor.deleteWorkspace(workspaceId);
  }

  exportFiles(workspaceId: string, dir: string): Promise<TerminalExportResult> {
    return this.executor.exportFiles(workspaceId, dir);
  }

  async importFiles(
    workspaceId: string,
    files: Readonly<Record<string, string>>,
  ): Promise<{ written: number }> {
    const count = Object.keys(files).length;
    await this.audit(
      RUN_TERMINAL_COMMAND_TOOL,
      { workspaceId, files: Object.keys(files) },
      `terminal: copiar ${count} archivo${count === 1 ? '' : 's'} del editor al proyecto`,
    );
    return this.executor.importFiles(workspaceId, files);
  }

  // ── Explorador de archivos del pod ─────────────────────────────────────

  fsList(workspaceId: string, path: string): Promise<TerminalFsList> {
    return this.executor.fsList(workspaceId, path);
  }

  fsRead(workspaceId: string, path: string): Promise<TerminalFsFile> {
    return this.executor.fsRead(workspaceId, path);
  }

  /** Audit ANTES (fail-closed): hash de la ruta, nunca el contenido. */
  async fsWrite(
    workspaceId: string,
    input: FsWriteInput,
  ): Promise<TerminalFsWritten> {
    await this.audit(
      WRITE_TERMINAL_FILE_TOOL,
      { workspaceId, path: input.path, force: input.force },
      `terminal: guardar ${input.path.slice(0, AUDIT_COMMAND_PREVIEW_LENGTH)}${input.force ? ' (sobrescribir)' : ''}`,
    );
    return this.executor.fsWrite(workspaceId, input);
  }

  async fsMkdir(workspaceId: string, path: string): Promise<void> {
    await this.audit(
      MAKE_TERMINAL_DIR_TOOL,
      { workspaceId, path },
      `terminal: crear carpeta ${path.slice(0, AUDIT_COMMAND_PREVIEW_LENGTH)}`,
    );
    await this.executor.fsMkdir(workspaceId, path);
  }

  async fsDelete(workspaceId: string, path: string): Promise<void> {
    await this.audit(
      DELETE_TERMINAL_ENTRY_TOOL,
      { workspaceId, path },
      `terminal: borrar ${path.slice(0, AUDIT_COMMAND_PREVIEW_LENGTH)}`,
    );
    await this.executor.fsDelete(workspaceId, path);
  }

  /**
   * Abre el stream de un comando. El audit va ANTES: sin registro no hay
   * comando (fail-closed).
   */
  async exec(
    workspaceId: string,
    input: ExecTerminalInput,
    signal: AbortSignal,
  ): Promise<Response> {
    const preview = input.command
      .replace(/\s+/g, ' ')
      .slice(0, AUDIT_COMMAND_PREVIEW_LENGTH);
    await this.audit(
      RUN_TERMINAL_COMMAND_TOOL,
      { workspaceId, command: input.command },
      `terminal: ${preview}`,
    );
    return this.executor.openExec(workspaceId, input, signal);
  }

  // ── Servidores en segundo plano y vista previa en vivo ─────────────────

  /**
   * Lanza un servidor dentro del workspace (`npm run dev`). Es un comando más
   * del owner: se audita ANTES (fail-closed) y no pide aprobación, porque no
   * expone nada afuera: la vista previa es privada (JWT del owner) y el pod
   * sigue sin más red que el proxy de npm. Publicar un link público sí pide
   * aprobación.
   */
  async startService(
    workspaceId: string,
    input: { command: string; port: number },
  ): Promise<TerminalServiceStart> {
    const preview = input.command
      .replace(/\s+/g, ' ')
      .slice(0, AUDIT_COMMAND_PREVIEW_LENGTH);
    await this.audit(
      RUN_TERMINAL_COMMAND_TOOL,
      { workspaceId, command: input.command, port: input.port },
      `terminal: [servidor :${input.port}] ${preview}`,
    );
    return this.executor.startService(workspaceId, input);
  }

  listServices(workspaceId: string): Promise<readonly TerminalServiceInfo[]> {
    return this.executor.listServices(workspaceId);
  }

  async stopService(workspaceId: string, port: number): Promise<void> {
    await this.audit(
      RUN_TERMINAL_COMMAND_TOOL,
      { workspaceId, stopPort: port },
      `terminal: detener el servidor :${port}`,
    );
    await this.executor.stopService(workspaceId, port);
  }

  serviceLogs(workspaceId: string, port: number): Promise<string> {
    return this.executor.serviceLogs(workspaceId, port);
  }

  /**
   * Reenvía una petición de la vista previa. NO se audita cada petición (una
   * página son decenas): abrir la vista previa es leer lo que el propio owner
   * levantó, y lo que la habilitó (el servidor) ya quedó en el audit.
   */
  previewRequest(
    workspaceId: string,
    port: number,
    request: {
      method: string;
      pathAndQuery: string;
      headers: Readonly<Record<string, string>>;
      body?: Buffer | undefined;
      signal: AbortSignal;
    },
  ): Promise<Response> {
    return this.executor.proxy(workspaceId, port, request);
  }

  private async audit(
    toolName: string,
    inputs: unknown,
    planSummary: string,
  ): Promise<void> {
    await this.auditService.recordToolCall({
      requestId: randomUUID(),
      actor: TERMINAL_ACTOR,
      toolName,
      inputsHash: computeInputsHash(inputs),
      planSummary,
      approvalStatus: 'auto',
    });
  }
}
