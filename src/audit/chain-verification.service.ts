import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { asc, eq } from 'drizzle-orm';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { auditChainLock, auditLog } from '../db/schema';
import { type ChainVerificationResult, verifyChain } from './hash-chain';

const LOCK_ROW_ID = 1;

/**
 * Verificación diaria de la cadena completa (BLUEPRINT 9.5). Si detecta
 * corrupción, bloquea nuevas escrituras (`isLocked()`, consultado por
 * AuditService) hasta intervención manual — regla de oro: un audit log
 * corrupto es peor que uno detenido.
 *
 * Estado persistido en `audit_chain_lock` (fila singleton, `id` fijo) —
 * a propósito, mismo criterio que `KillSwitchService`/`budget_kill_switch`:
 * un simple redeploy no debe reanudar escrituras sobre una cadena que
 * sigue corrupta. Antes vivía en memoria (`private locked`) — gap
 * documentado en comentarios ajenos (`kill-switch.service.ts`,
 * `db/schema.ts`) desde que se escribió este módulo, nunca resuelto
 * hasta ahora.
 */
@Injectable()
export class ChainVerificationService {
  private readonly logger = new Logger(ChainVerificationService.name);

  constructor(@Inject(DB_CONNECTION) private readonly db: Db) {}

  async isLocked(): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(auditChainLock)
      .where(eq(auditChainLock.id, LOCK_ROW_ID));
    return rows[0]?.locked ?? false;
  }

  /** Solo para tests/runbooks de recuperación manual — nunca se llama desde código de negocio. */
  async unlock(): Promise<void> {
    await this.upsertLock({ locked: false, lockedAt: null, reason: null });
  }

  @Cron('0 4 * * *')
  async verifyDaily(): Promise<ChainVerificationResult> {
    const rows = await this.db
      .select()
      .from(auditLog)
      .orderBy(asc(auditLog.id));
    const result = verifyChain(rows);

    if (!result.valid) {
      const reason = `Audit chain CORRUPTA en la fila id=${String(result.brokenAtId)}.`;
      await this.upsertLock({ locked: true, lockedAt: new Date(), reason });
      this.logger.error(
        `${reason} Escritura bloqueada hasta intervención manual.`,
      );
    } else {
      this.logger.log(`Audit chain verificada: ${rows.length} filas, OK.`);
    }

    return result;
  }

  private async upsertLock(state: {
    locked: boolean;
    lockedAt: Date | null;
    reason: string | null;
  }): Promise<void> {
    await this.db
      .insert(auditChainLock)
      .values({ id: LOCK_ROW_ID, ...state })
      .onConflictDoUpdate({
        target: auditChainLock.id,
        set: state,
      });
  }
}
