import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { pendingApprovals, type PendingApprovalRow } from '../db/schema';
import { getToolDefinition } from '../tools/registry';
import {
  DualConfirmService,
  STUCK_CLAIM_AFTER_MS,
} from './dual-confirm.service';
import { decideTimeoutOutcome } from './timeout.logic';

// docs/RECOMENDACIONES.md #11: antes solo un `logger.warn`/`logger.error`
// que nadie mira — "notificación real llega en Fase 2.4" nunca se
// recableó pese a que esa fase cerró hace semanas. `TelegramBotService`
// escucha estos eventos (mismo mecanismo que `PENDING_APPROVAL_CREATED_EVENT`
// en dual-confirm.service.ts) — evita el import circular
// HitlModule→TelegramModule→HitlModule que una inyección directa crearía.
export const HITL_APPROVAL_ESCALATED_EVENT = 'hitl.approval.escalated';
export const HITL_APPROVAL_ABANDONED_EVENT = 'hitl.approval.abandoned';
// Issue #36: una aprobación quedó "reclamada" (ejecutándose) y nunca terminó
// -- el proceso murió entre el claim y el final. La acción pudo o no haber
// ocurrido, así que NO se reintenta ni se descarta sola: se avisa al owner.
export const HITL_APPROVAL_STUCK_EVENT = 'hitl.approval.stuck';

export interface HitlApprovalTimeoutEvent {
  readonly requestId: string;
  readonly toolName: string;
}

/**
 * Barrido de aprobaciones pendientes vencidas (BLUEPRINT 9.4). El
 * timeout NUNCA aprueba (regla de oro #9): solo descarta o escala.
 */
@Injectable()
export class TimeoutService {
  private readonly logger = new Logger(TimeoutService.name);

  constructor(
    @Inject(DB_CONNECTION) private readonly db: Db,
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
    private readonly dualConfirmService: DualConfirmService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweep(now: Date = new Date()): Promise<void> {
    const pending = await this.db.select().from(pendingApprovals);
    for (const row of pending) {
      await this.processPending(row, now);
    }
  }

  private async processPending(
    pending: PendingApprovalRow,
    now: Date,
  ): Promise<void> {
    // Una aprobación que se está ejecutando (o quedó trabada ejecutándose)
    // NUNCA se descarta ni se abandona desde acá: sería competir con la
    // acción real. Si el reclamo está trabado se avisa; el barrido es
    // horario, así que el aviso se repite cada hora hasta que el owner
    // actúe (rechazarla con /reject es la vía para limpiarla).
    if (pending.executingAt) {
      if (
        now.getTime() - pending.executingAt.getTime() >
        STUCK_CLAIM_AFTER_MS
      ) {
        this.logger.error(
          `Aprobación TRABADA ejecutándose desde ${pending.executingAt.toISOString()}: ${pending.requestId} (${pending.toolName}). No se reintenta.`,
        );
        this.eventEmitter.emit(HITL_APPROVAL_STUCK_EVENT, {
          requestId: pending.requestId,
          toolName: pending.toolName,
        } satisfies HitlApprovalTimeoutEvent);
      }
      return;
    }

    const tool = getToolDefinition(pending.toolName);
    const timeoutBehavior = tool?.timeoutBehavior ?? 'discard';

    const outcome = decideTimeoutOutcome({
      createdAt: pending.createdAt,
      timeoutBehavior,
      alreadyEscalated: pending.escalatedAt !== null,
      now,
    });

    switch (outcome.action) {
      case 'none':
        return;

      case 'discard':
        if (!(await this.claimAndAuditTimeout(pending, 'timeout'))) return;
        await this.removePending(pending.requestId);
        this.logger.warn(
          `Aprobación descartada por timeout (24h): ${pending.requestId} (${pending.toolName})`,
        );
        return;

      case 'escalate-warning':
        await this.db
          .update(pendingApprovals)
          .set({ escalatedAt: now })
          .where(eq(pendingApprovals.requestId, pending.requestId));
        this.logger.warn(
          `Escalando aprobación pendiente (12h sin respuesta): ${pending.requestId} (${pending.toolName}).`,
        );
        this.eventEmitter.emit(HITL_APPROVAL_ESCALATED_EVENT, {
          requestId: pending.requestId,
          toolName: pending.toolName,
        } satisfies HitlApprovalTimeoutEvent);
        return;

      case 'abandon':
        if (!(await this.claimAndAuditTimeout(pending, 'abandoned'))) return;
        await this.removePending(pending.requestId);
        this.logger.error(
          `Aprobación ABANDONADA tras 24h sin respuesta: ${pending.requestId} (${pending.toolName})`,
        );
        this.eventEmitter.emit(HITL_APPROVAL_ABANDONED_EVENT, {
          requestId: pending.requestId,
          toolName: pending.toolName,
        } satisfies HitlApprovalTimeoutEvent);
        return;
    }
  }

  /**
   * Reclama la fila con el MISMO primitivo atómico que la ejecución
   * (`claimForExecution`) antes de auditar y descartar: si otra solicitud la
   * está ejecutando en este instante, esta expiración pierde y se salta (la
   * acción real manda). Si el audit falla, el reclamo se libera y el
   * próximo barrido reintenta -- mismo comportamiento de antes.
   */
  private async claimAndAuditTimeout(
    pending: PendingApprovalRow,
    status: 'timeout' | 'abandoned',
  ): Promise<boolean> {
    const claimed = await this.dualConfirmService.claimForExecution(
      pending.requestId,
    );
    if (!claimed) return false;
    try {
      await this.auditService.recordTimeout({
        requestId: pending.requestId,
        toolName: pending.toolName,
        inputsHash: pending.inputsHash,
        status,
      });
    } catch (err: unknown) {
      await this.dualConfirmService.releaseClaim(pending.requestId);
      throw err;
    }
    return true;
  }

  private async removePending(requestId: string): Promise<void> {
    await this.db
      .delete(pendingApprovals)
      .where(eq(pendingApprovals.requestId, requestId));
  }
}
