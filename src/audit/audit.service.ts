import { Inject, Injectable } from '@nestjs/common';
import { desc, sql } from 'drizzle-orm';
import { JinError } from '../common/errors/jin-error';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { auditLog, type AuditLogRow, type NewAuditLogRow } from '../db/schema';
import { ChainVerificationService } from './chain-verification.service';
import { computeRowHash, GENESIS_HASH, type HashableRow } from './hash-chain';

export class AuditChainLockedError extends JinError {
  constructor() {
    super(
      'El audit log está bloqueado tras detectar corrupción en la cadena — requiere intervención manual (BLUEPRINT 9.5).',
      { code: 'AUDIT_CHAIN_LOCKED', httpStatus: 503 },
    );
  }
}

type AppendableRow = Omit<HashableRow, 'timestamp'>;

/**
 * API pública para registrar acciones en el audit log inmutable
 * (BLUEPRINT 9.5, ADR 0002). Cada método hace un INSERT — nunca un
 * UPDATE — de una fila nueva. `request_id` correlaciona las filas de un
 * mismo evento lógico.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(DB_CONNECTION) private readonly db: Db,
    private readonly chainVerification: ChainVerificationService,
  ) {}

  async recordToolCall(input: {
    requestId: string;
    actor: string;
    toolName: string;
    inputsHash: string;
    planSummary?: string;
    approvalStatus: 'auto' | 'notified' | 'pending';
    externalInputsSummary?: string;
  }): Promise<AuditLogRow> {
    return this.appendRow({
      requestId: input.requestId,
      actor: input.actor,
      actionType: 'tool_call',
      toolName: input.toolName,
      inputsHash: input.inputsHash,
      planSummary: input.planSummary ?? null,
      approvalStatus: input.approvalStatus,
      approver: null,
      externalInputsSummary: input.externalInputsSummary ?? null,
    });
  }

  async recordApproval(input: {
    requestId: string;
    approver: string;
    toolName: string;
    inputsHash: string;
  }): Promise<AuditLogRow> {
    return this.appendRow({
      requestId: input.requestId,
      actor: 'user',
      actionType: 'approval',
      toolName: input.toolName,
      inputsHash: input.inputsHash,
      planSummary: null,
      approvalStatus: 'approved',
      approver: input.approver,
      externalInputsSummary: null,
    });
  }

  async recordRejection(input: {
    requestId: string;
    approver: string;
    toolName: string;
    inputsHash: string;
  }): Promise<AuditLogRow> {
    return this.appendRow({
      requestId: input.requestId,
      actor: 'user',
      actionType: 'rejection',
      toolName: input.toolName,
      inputsHash: input.inputsHash,
      planSummary: null,
      approvalStatus: 'rejected',
      approver: input.approver,
      externalInputsSummary: null,
    });
  }

  async recordTimeout(input: {
    requestId: string;
    toolName: string;
    inputsHash: string;
    status: 'timeout' | 'abandoned';
  }): Promise<AuditLogRow> {
    return this.appendRow({
      requestId: input.requestId,
      actor: 'system',
      actionType: 'timeout',
      toolName: input.toolName,
      inputsHash: input.inputsHash,
      planSummary: null,
      approvalStatus: input.status,
      approver: null,
      externalInputsSummary: null,
    });
  }

  private async appendRow(data: AppendableRow): Promise<AuditLogRow> {
    if (this.chainVerification.isLocked()) {
      throw new AuditChainLockedError();
    }

    return this.db.transaction(async (tx) => {
      // Advisory lock transaccional: serializa los appends del hash chain
      // incluso entre procesos distintos — relevante durante un rolling
      // update (BLUEPRINT 12.2), donde brevemente pueden coexistir 2
      // réplicas escribiendo. Se libera solo al terminar la transacción.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('jin_audit_log_chain'))`,
      );

      const [last] = await tx
        .select({ currentHash: auditLog.currentHash })
        .from(auditLog)
        .orderBy(desc(auditLog.id))
        .limit(1);
      const prevHash = last?.currentHash ?? GENESIS_HASH;

      const timestamp = new Date();
      const currentHash = computeRowHash(prevHash, { ...data, timestamp });

      const values: NewAuditLogRow = {
        ...data,
        timestamp,
        prevHash,
        currentHash,
      };
      const [inserted] = await tx.insert(auditLog).values(values).returning();
      if (!inserted) {
        throw new Error('INSERT a audit_log no devolvió la fila creada.');
      }
      return inserted;
    });
  }
}
