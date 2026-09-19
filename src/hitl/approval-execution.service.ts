import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import {
  ApprovalAlreadyResolvedError,
  DualConfirmService,
  PendingApprovalNotFoundError,
  STUCK_CLAIM_AFTER_MS,
} from './dual-confirm.service';
import { ToolExecutorRegistry } from './tool-executor.registry';

export interface ResolveAndExecuteAwaitingSecond {
  readonly outcome: 'awaiting-second';
}

export interface ResolveAndExecuteResolved {
  readonly outcome: 'resolved';
  readonly toolName: string;
  readonly result: unknown;
}

export type ResolveAndExecuteResult =
  ResolveAndExecuteAwaitingSecond | ResolveAndExecuteResolved;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Orquesta la mitad "aprobar → ejecutar" del ciclo HITL para tools
 * `confirm`/`dual-confirm` (prerequisito de Fase 4.2, ver STATUS.md).
 *
 * Issue #36 / ADR 0010: la ejecución es una acción IRREVERSIBLE (p. ej.
 * `sendEmail` ante un tercero), así que se protege con un reclamo atómico
 * (`DualConfirmService.claimForExecution`) ANTES de tocar nada. Garantías:
 *  - **a lo sumo una vez**: N aprobaciones simultáneas ejecutan una sola vez;
 *  - **fail-closed**: la intención se audita antes de ejecutar; si el audit
 *    falla, la acción NO ocurre;
 *  - **sin reintento automático**: si el executor falla, el pendiente queda
 *    vivo y exige una nueva aprobación humana (regla de oro #9).
 */
@Injectable()
export class ApprovalExecutionService {
  private readonly logger = new Logger(ApprovalExecutionService.name);

  constructor(
    private readonly dualConfirmService: DualConfirmService,
    private readonly auditService: AuditService,
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
  ) {}

  /**
   * Puede lanzar `PendingApprovalNotFoundError`,
   * `SecondApprovalTooEarlyError` (propagadas desde
   * `DualConfirmService.recordApproval`) o `ApprovalAlreadyResolvedError`
   * (otra solicitud ya reclamó la ejecución). Solo ejecuta la acción real
   * cuando el outcome es `'resolved'` — la primera aprobación de un
   * dual-confirm nunca ejecuta nada.
   */
  async resolveAndExecute(
    requestId: string,
    approver: string,
  ): Promise<ResolveAndExecuteResult> {
    const pending = await this.dualConfirmService.getPending(requestId);
    if (!pending) {
      throw new PendingApprovalNotFoundError(requestId);
    }

    const outcome = await this.dualConfirmService.recordApproval(
      requestId,
      approver,
    );

    if (outcome === 'awaiting-second') {
      return { outcome: 'awaiting-second' };
    }

    // Punto de no retorno: desde acá solo UNA llamada puede continuar.
    const claimed = await this.dualConfirmService.claimForExecution(requestId);
    if (!claimed) {
      throw new ApprovalAlreadyResolvedError(requestId);
    }

    // Audit de la INTENCIÓN antes de ejecutar (fail-closed): si la cadena
    // está bloqueada o la DB falla, una acción irreversible no debe ocurrir
    // sin rastro.
    try {
      await this.auditService.recordApproval({
        requestId,
        approver,
        toolName: claimed.toolName,
        inputsHash: claimed.inputsHash,
      });
    } catch (err: unknown) {
      await this.dualConfirmService.releaseClaim(
        requestId,
        `audit falló antes de ejecutar: ${messageOf(err)}`,
      );
      throw err;
    }

    let result: unknown;
    try {
      result = await this.toolExecutorRegistry.execute(
        claimed.toolName,
        claimed.payload,
      );
    } catch (err: unknown) {
      // No se reintenta sola: el pendiente vuelve a estar disponible y
      // exige otra aprobación humana. El fallo queda auditado y visible.
      await this.dualConfirmService.releaseClaim(requestId, messageOf(err));
      await this.auditService
        .recordExecutionFailure({
          requestId,
          toolName: claimed.toolName,
          inputsHash: claimed.inputsHash,
        })
        .catch((auditErr: unknown) =>
          this.logger.error(
            `No se pudo auditar el fallo de ejecución de ${requestId}: ${messageOf(auditErr)}`,
          ),
        );
      throw err;
    }

    try {
      await this.dualConfirmService.removePending(requestId);
    } catch (err: unknown) {
      // La acción YA ocurrió. Si el borrado falla, la fila queda reclamada
      // (`executing_at` seteado) y por eso no puede aprobarse ni ejecutarse
      // de nuevo; TimeoutService avisa del reclamo trabado. Devolver éxito es
      // lo correcto: la acción se hizo.
      this.logger.error(
        `Acción ${requestId} ejecutada pero no se pudo borrar el pendiente (queda reclamado, no se reejecuta): ${messageOf(err)}`,
      );
    }

    return { outcome: 'resolved', toolName: claimed.toolName, result };
  }

  /**
   * Rechazar nunca ejecuta la acción. Tampoco puede llegar a mitad de una
   * ejecución en curso (`ApprovalAlreadyResolvedError`): se reclama la fila
   * igual que para ejecutar. Un reclamo TRABADO (>`STUCK_CLAIM_AFTER_MS`, ver
   * `TimeoutService`) sí puede rechazarse: es la vía del owner para limpiarlo.
   */
  async resolveRejection(requestId: string, approver: string): Promise<void> {
    const pending = await this.dualConfirmService.getPending(requestId);
    if (!pending) {
      throw new PendingApprovalNotFoundError(requestId);
    }

    const claimed = await this.dualConfirmService.claimForExecution(requestId);
    if (!claimed) {
      const executingSince = pending.executingAt?.getTime();
      const isStuck =
        executingSince !== undefined &&
        Date.now() - executingSince > STUCK_CLAIM_AFTER_MS;
      if (!isStuck) {
        throw new ApprovalAlreadyResolvedError(requestId);
      }
      await this.auditService.recordRejection({
        requestId,
        approver,
        toolName: pending.toolName,
        inputsHash: pending.inputsHash,
      });
      await this.dualConfirmService.removeIfNotExecuting(requestId);
      return;
    }

    try {
      await this.auditService.recordRejection({
        requestId,
        approver,
        toolName: claimed.toolName,
        inputsHash: claimed.inputsHash,
      });
    } catch (err: unknown) {
      await this.dualConfirmService.releaseClaim(requestId);
      throw err;
    }

    await this.dualConfirmService.removePending(requestId);
  }
}
