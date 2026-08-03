import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { JinError } from '../common/errors/jin-error';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { pendingApprovals, type PendingApprovalRow } from '../db/schema';
import {
  canAcceptSecondApproval,
  computeAvailableAt,
} from './dual-confirm.logic';

const PendingApprovalLevelSchema = z.enum(['confirm', 'dual-confirm']);

// Único emit point real (Fase 6.1, ADR 0007 decisión #5) — el WebSocket
// gateway (`src/realtime/`) escucha esto para empujar `pending-approval:new`
// sin polling: es el único evento donde la latencia de hasta 5 min de un
// `@Cron` importaría de verdad (una aprobación nueva debe verse ya).
export const PENDING_APPROVAL_CREATED_EVENT = 'pending-approval.created';

export interface PendingApprovalCreatedEvent {
  readonly requestId: string;
  readonly toolName: string;
  readonly level: 'confirm' | 'dual-confirm';
}

export class PendingApprovalNotFoundError extends JinError {
  constructor(requestId: string) {
    super(`No hay aprobación pendiente con requestId "${requestId}"`, {
      code: 'HITL_PENDING_APPROVAL_NOT_FOUND',
      httpStatus: 404,
    });
  }
}

export class SecondApprovalTooEarlyError extends JinError {
  constructor(requestId: string, availableAt: Date) {
    super(
      `La segunda aprobación de "${requestId}" no se acepta antes de ${availableAt.toISOString()}`,
      { code: 'HITL_SECOND_APPROVAL_TOO_EARLY', httpStatus: 409 },
    );
  }
}

export interface CreatePendingApprovalInput {
  readonly requestId: string;
  readonly toolName: string;
  readonly level: 'confirm' | 'dual-confirm';
  readonly inputsHash: string;
  readonly planSummary?: string;
  /**
   * Datos de la acción real a ejecutar si se aprueba (ej. to/subject/body
   * de un email) — consumido por `ApprovalExecutionService` vía
   * `ToolExecutorRegistry` al resolverse la aprobación. Ausente para
   * acciones sin ejecución diferida.
   */
  readonly payload?: unknown;
}

export type ApprovalOutcome = 'resolved' | 'awaiting-second';

/**
 * Máquina de estados de las aprobaciones `confirm`/`dual-confirm`
 * (BLUEPRINT 9.1-9.2, ADR 0002). Estado persistido en `pending_approvals`
 * — nunca en memoria — para sobrevivir a un restart del pod.
 */
@Injectable()
export class DualConfirmService {
  constructor(
    @Inject(DB_CONNECTION) private readonly db: Db,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async createPendingApproval(
    input: CreatePendingApprovalInput,
  ): Promise<void> {
    await this.db.insert(pendingApprovals).values({
      requestId: input.requestId,
      toolName: input.toolName,
      level: input.level,
      inputsHash: input.inputsHash,
      planSummary: input.planSummary ?? null,
      payload: input.payload ?? null,
    });

    this.eventEmitter.emit(PENDING_APPROVAL_CREATED_EVENT, {
      requestId: input.requestId,
      toolName: input.toolName,
      level: input.level,
    } satisfies PendingApprovalCreatedEvent);
  }

  /** Usado por `hitl.controller.ts` (Fase 6.1) — mismo query que armaba Telegram a mano en `/tasks`. */
  async listPending(): Promise<readonly PendingApprovalRow[]> {
    return this.db
      .select()
      .from(pendingApprovals)
      .orderBy(desc(pendingApprovals.createdAt));
  }

  async getPending(requestId: string): Promise<PendingApprovalRow | undefined> {
    const rows = await this.db
      .select()
      .from(pendingApprovals)
      .where(eq(pendingApprovals.requestId, requestId));
    return rows[0];
  }

  /**
   * Registra una aprobación humana. Para 'confirm' resuelve de inmediato.
   * Para 'dual-confirm': la primera llamada arma el temporizador de 30s
   * y devuelve 'awaiting-second'; la segunda solo resuelve si ya pasaron
   * esos 30s — nunca antes (defensa en profundidad: no confía en que la
   * UI haya esperado, BLUEPRINT 9.2).
   */
  async recordApproval(
    requestId: string,
    approver: string,
    now: Date = new Date(),
  ): Promise<ApprovalOutcome> {
    const pending = await this.getPending(requestId);
    if (!pending) {
      throw new PendingApprovalNotFoundError(requestId);
    }

    const level = PendingApprovalLevelSchema.parse(pending.level);

    if (level === 'confirm') {
      return 'resolved';
    }

    if (!pending.firstApprovedAt) {
      const availableAt = computeAvailableAt(now);
      await this.db
        .update(pendingApprovals)
        .set({ firstApprovedAt: now, firstApprover: approver, availableAt })
        .where(eq(pendingApprovals.requestId, requestId));
      return 'awaiting-second';
    }

    const availableAt =
      pending.availableAt ?? computeAvailableAt(pending.firstApprovedAt);
    if (!canAcceptSecondApproval(availableAt, now)) {
      throw new SecondApprovalTooEarlyError(requestId, availableAt);
    }

    return 'resolved';
  }

  async removePending(requestId: string): Promise<void> {
    await this.db
      .delete(pendingApprovals)
      .where(eq(pendingApprovals.requestId, requestId));
  }
}
