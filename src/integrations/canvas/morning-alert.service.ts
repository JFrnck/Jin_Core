import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { desc, gte } from 'drizzle-orm';
import { AuditService } from '../../audit/audit.service';
import { DB_CONNECTION, type Db } from '../../db/db.module';
import { shadowingRuns } from '../../db/schema';
import {
  MORNING_ALERT_EVENT,
  type MorningAlertEvent,
} from './morning-alert.events';

/**
 * Una corrida de las 00:00 más vieja que esto no cuenta como "la de anoche":
 * 6 h esperadas + margen. Evita presentar el resumen de hace dos días como si
 * fuera el de hoy cuando el cron de anoche no corrió.
 */
export const MAX_RUN_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Alerta matutina 06:00 (BLUEPRINT §7.1, Fase 9.4). Reutiliza el resultado
 * que `ShadowingService` persistió a las 00:00 -- CERO llamadas extra al LLM
 * (recalcular sería una segunda llamada Gemini 3.1 Pro al día contra el budget
 * guard; las fechas de entrega son absolutas, el resumen de 6 h sigue vigente).
 *
 * HITL `auto` (solo informa) pero pasa por el audit log igual. Nunca envía un
 * resumen vacío: si la corrida falló o no existe, lo dice explícitamente.
 *
 * "06:00 local" depende de `TZ` del pod (Jin_Infra: `TZ=America/Lima`).
 */
@Injectable()
export class MorningAlertService {
  private readonly logger = new Logger(MorningAlertService.name);

  constructor(
    @Inject(DB_CONNECTION) private readonly db: Db,
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Cron('0 6 * * *')
  async handleCron(): Promise<void> {
    try {
      await this.run();
    } catch (err) {
      this.logger.error(
        'Error durante la alerta matutina de las 06:00',
        err instanceof Error ? err.stack : String(err),
      );
    }
  }

  async run(now: Date = new Date()): Promise<MorningAlertEvent> {
    const [latest] = await this.db
      .select()
      .from(shadowingRuns)
      .where(gte(shadowingRuns.ranAt, new Date(now.getTime() - MAX_RUN_AGE_MS)))
      .orderBy(desc(shadowingRuns.ranAt))
      .limit(1);

    let event: MorningAlertEvent;
    if (!latest) {
      event = { kind: 'missing' };
    } else if (latest.status === 'ok' && latest.summaryMarkdown) {
      event = {
        kind: 'summary',
        ranAt: latest.ranAt.toISOString(),
        summaryMarkdown: latest.summaryMarkdown,
      };
    } else {
      // status 'failed', o una fila 'ok' sin resumen (no debería ocurrir):
      // ante la duda se avisa en vez de enviar algo vacío.
      event = {
        kind: 'failed',
        ranAt: latest.ranAt.toISOString(),
        error: latest.error ?? 'la corrida terminó sin resumen',
      };
    }

    // El aviso sale ANTES del audit: es informativo (`auto`), no una acción
    // irreversible, así que un audit bloqueado no debe silenciarlo (a
    // diferencia de la ejecución HITL, que es fail-closed).
    this.eventEmitter.emit(MORNING_ALERT_EVENT, event);

    try {
      await this.auditService.recordToolCall({
        requestId: randomUUID(),
        actor: 'system_cron',
        toolName: 'morning_alert_cron',
        inputsHash: createHash('sha256')
          .update(JSON.stringify({ kind: event.kind, ranAt: latest?.ranAt }))
          .digest('hex'),
        planSummary: `Alerta matutina 06:00 (${event.kind})`,
        approvalStatus: 'auto',
      });
    } catch (err) {
      this.logger.error(
        'La alerta matutina se envió pero no se pudo auditar',
        err instanceof Error ? err.stack : String(err),
      );
    }

    return event;
  }
}
