import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { autonomyModeState } from '../db/schema';
import { DualConfirmService } from '../hitl/dual-confirm.service';
import type { HitlDecision } from '../hitl/types';
import { ToolExecutorRegistry } from '../hitl/tool-executor.registry';
import { listRegisteredTools, type ToolDefinition } from '../tools/registry';
import type { AutonomyConfig } from './autonomy-config.schema';
import {
  AUTONOMY_MODE_CHANGED_EVENT,
  type AutonomyChangeReason,
  type AutonomyModeChangedEvent,
} from './autonomy.events';
import { clampHours, relaxDecision } from './autonomy.logic';
import { AUTONOMY_CONFIG } from './autonomy.tokens';
import {
  AutonomyModeSchema,
  requiresDualConfirm,
  type AutonomyMode,
  type AutonomyState,
} from './autonomy.types';

const STATE_ROW_ID = 1;

/**
 * Nombre del "tool" virtual que aplica un cambio de modo al aprobarse. NO
 * está en `src/tools/registry.ts`: el agente solo expone al LLM lo que está
 * ahí, y `classifyToolCall` lanza `UnknownToolError` para cualquier otro
 * nombre -- el LLM no puede ni verlo ni invocarlo (regla de oro #4). Es el
 * mismo mecanismo que usa `FeatureFlagsService` para los overrides de nivel.
 */
export const AUTONOMY_MODE_CHANGE_TOOL_NAME = 'autonomyModeChange';

const ApprovedChangePayloadSchema = z.object({
  mode: AutonomyModeSchema,
  hours: z.number().int().positive(),
  approvalRequestId: z.string().uuid(),
});

export type ModeChangeResult =
  | {
      readonly status: 'applied';
      readonly mode: AutonomyMode;
      readonly expiresAt: string | null;
    }
  | {
      readonly status: 'pending-approval';
      readonly requestId: string;
      readonly mode: AutonomyMode;
      readonly hours: number;
    };

export interface AutonomyDescription {
  readonly mode: AutonomyMode;
  readonly expiresAt: string | null;
  readonly remainingSeconds: number | null;
  readonly setBy: string;
  readonly limits: {
    readonly semiAuto: AutonomyConfig['semiAuto'];
    readonly auto: AutonomyConfig['auto'];
    readonly maxRelaxedActionsPerHour: number;
  };
  /** Tools que en modo semi-auto siguen pidiendo aprobación (marca estática del registry). */
  readonly guardedInSemiAuto: string[];
}

const SAFE_STATE = (now: Date, setBy: string): AutonomyState => ({
  mode: 'supervised',
  expiresAt: null,
  setBy,
  changedAt: now,
});

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Modos de autonomía del HITL (ADR 0010, decisión del owner 2026-09-19).
 *
 * Invariantes -- cada uno tiene su test:
 * 1. El default y el fallo siempre son `supervised` (fila ausente, modo
 *    inválido, relajado sin caducidad, o caducado).
 * 2. Solo el OWNER cambia el modo, por caminos autenticados; bajar la
 *    protección exige `dual-confirm` real (2 aprobaciones ≥30 s), subirla no.
 * 3. Todo modo relajado caduca solo; un freno de emergencia lo revierte si se
 *    autoejecutan demasiadas acciones por hora.
 * 4. `dual-confirm` y `humanDecision` jamás se relajan (ver `relaxDecision`).
 */
@Injectable()
export class AutonomyService implements OnModuleInit {
  private readonly logger = new Logger(AutonomyService.name);

  constructor(
    @Inject(DB_CONNECTION) private readonly db: Db,
    @Inject(AUTONOMY_CONFIG) private readonly config: AutonomyConfig,
    private readonly dualConfirmService: DualConfirmService,
    private readonly auditService: AuditService,
    private readonly toolExecutorRegistry: ToolExecutorRegistry,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.toolExecutorRegistry.register(
      AUTONOMY_MODE_CHANGE_TOOL_NAME,
      async (payload) => this.applyApprovedChange(payload),
    );
  }

  /** Modo EFECTIVO ahora: descuenta la caducidad y cae a `supervised` ante cualquier duda. */
  async getState(now: Date = new Date()): Promise<AutonomyState> {
    const [row] = await this.db
      .select()
      .from(autonomyModeState)
      .where(eq(autonomyModeState.id, STATE_ROW_ID));
    if (!row) return SAFE_STATE(now, 'system:default');

    const parsed = AutonomyModeSchema.safeParse(row.mode);
    if (!parsed.success || parsed.data === 'supervised') {
      return SAFE_STATE(now, row.setBy);
    }
    // Un modo relajado SIEMPRE tiene caducidad; sin ella (o vencida) es seguro.
    if (!row.expiresAt || row.expiresAt.getTime() <= now.getTime()) {
      return SAFE_STATE(now, 'system:expiry');
    }
    return {
      mode: parsed.data,
      expiresAt: row.expiresAt,
      setBy: row.setBy,
      changedAt: row.changedAt,
    };
  }

  /**
   * Aplica el modo vigente a una decisión ya clasificada. Si relaja, cuenta
   * la acción contra el freno de emergencia: al superar el umbral el modo
   * vuelve a `supervised` y ESTA acción vuelve a pedir aprobación.
   */
  async relax(
    decision: HitlDecision,
    tool:
      Pick<ToolDefinition, 'guardedInSemiAuto' | 'humanDecision'> | undefined,
  ): Promise<HitlDecision> {
    const state = await this.getState();
    const result = relaxDecision(decision, state.mode, tool);
    if (result.relaxedBy === undefined) return decision;

    const count = await this.bumpRelaxedCounter();
    if (count > this.config.maxRelaxedActionsPerHour) {
      this.logger.error(
        `Freno de emergencia: ${count} acciones autoejecutadas en 1 h (máx ${this.config.maxRelaxedActionsPerHour}). Vuelve a HITL completo.`,
      );
      await this.applyRestrictiveChange(
        'supervised',
        'system:circuit-breaker',
        'circuit-breaker',
      );
      return decision;
    }
    return result.decision;
  }

  /**
   * Punto de entrada del owner (Telegram `/mode`, `POST /api/autonomy`).
   * Volver a algo más restrictivo es inmediato; bajar la protección crea una
   * aprobación `dual-confirm` REAL que se resuelve por los caminos normales
   * (`/approve` dos veces, dashboard, CLI).
   */
  async requestModeChange(input: {
    readonly mode: AutonomyMode;
    readonly hours?: number;
    readonly requestedBy: string;
  }): Promise<ModeChangeResult> {
    const current = await this.getState();

    if (!requiresDualConfirm(current.mode, input.mode)) {
      const hours =
        input.mode === 'supervised'
          ? 0
          : clampHours(input.hours, this.limitsFor(input.mode));
      const expiresAt = await this.applyRestrictiveChange(
        input.mode,
        input.requestedBy,
        'downgrade',
        hours,
      );
      return { status: 'applied', mode: input.mode, expiresAt };
    }

    const hours = clampHours(input.hours, this.limitsFor(input.mode));
    const requestId = randomUUID();
    const payload = { mode: input.mode, hours, approvalRequestId: requestId };
    await this.dualConfirmService.createPendingApproval({
      requestId,
      toolName: AUTONOMY_MODE_CHANGE_TOOL_NAME,
      level: 'dual-confirm',
      inputsHash: hashOf(payload),
      planSummary: `Cambiar el modo de autonomía a "${input.mode}" durante ${hours} h (baja la protección del HITL). Se autoejecutan las acciones que hoy piden 1 aprobación${input.mode === 'semi-auto' ? ', salvo git/merges, correos y borrar eventos futuros' : ''}; lo dual-confirm sigue igual.`,
      payload,
      actor: input.requestedBy,
    });
    return { status: 'pending-approval', requestId, mode: input.mode, hours };
  }

  /** Ejecutor de la aprobación dual-confirm (registrado en `onModuleInit`). */
  async applyApprovedChange(rawPayload: unknown): Promise<{ ok: true }> {
    const payload = ApprovedChangePayloadSchema.parse(rawPayload);
    // Defensa en profundidad: aunque el pendiente ya viene acotado, se
    // vuelve a acotar contra la config vigente.
    const hours =
      payload.mode === 'supervised'
        ? 0
        : clampHours(payload.hours, this.limitsFor(payload.mode));
    // Bajar la protección: se audita ANTES de aplicar (fail-closed). Si el
    // audit falla, el modo NO cambia y la aprobación queda para reintento humano.
    await this.writeState({
      mode: payload.mode,
      hours,
      setBy: 'owner:dual-confirm',
      reason: 'approved',
      approvalRequestId: payload.approvalRequestId,
      auditBeforeApply: true,
    });
    return { ok: true };
  }

  /** Cada minuto: los modos relajados vencidos vuelven solos a `supervised`. */
  @Cron('* * * * *')
  async expireIfNeeded(now: Date = new Date()): Promise<void> {
    const [row] = await this.db
      .select()
      .from(autonomyModeState)
      .where(eq(autonomyModeState.id, STATE_ROW_ID));
    if (!row || row.mode === 'supervised') return;
    if (row.expiresAt && row.expiresAt.getTime() > now.getTime()) return;
    await this.applyRestrictiveChange('supervised', 'system:expiry', 'expired');
  }

  async describe(now: Date = new Date()): Promise<AutonomyDescription> {
    const state = await this.getState(now);
    return {
      mode: state.mode,
      expiresAt: state.expiresAt ? state.expiresAt.toISOString() : null,
      remainingSeconds: state.expiresAt
        ? Math.max(
            0,
            Math.round((state.expiresAt.getTime() - now.getTime()) / 1000),
          )
        : null,
      setBy: state.setBy,
      limits: {
        semiAuto: this.config.semiAuto,
        auto: this.config.auto,
        maxRelaxedActionsPerHour: this.config.maxRelaxedActionsPerHour,
      },
      guardedInSemiAuto: listRegisteredTools()
        .filter((t) => t.guardedInSemiAuto === true)
        .map((t) => t.name),
    };
  }

  private limitsFor(mode: AutonomyMode): AutonomyConfig['auto'] {
    return mode === 'auto' ? this.config.auto : this.config.semiAuto;
  }

  /**
   * Cambios que NO bajan la protección (volver a supervised, o a un modo más
   * restrictivo, o caducar): se aplican SIEMPRE, aunque el audit falle -- un
   * fallo del audit nunca debe impedir volver al modo seguro.
   */
  private async applyRestrictiveChange(
    mode: AutonomyMode,
    setBy: string,
    reason: AutonomyChangeReason,
    hours = 0,
  ): Promise<string | null> {
    return this.writeState({
      mode,
      hours,
      setBy,
      reason,
      approvalRequestId: null,
      auditBeforeApply: false,
    });
  }

  private async writeState(input: {
    readonly mode: AutonomyMode;
    readonly hours: number;
    readonly setBy: string;
    readonly reason: AutonomyChangeReason;
    readonly approvalRequestId: string | null;
    readonly auditBeforeApply: boolean;
  }): Promise<string | null> {
    const now = new Date();
    const previous = (await this.getState(now)).mode;
    const expiresAt =
      input.mode === 'supervised'
        ? null
        : new Date(now.getTime() + input.hours * 60 * 60 * 1000);

    const audit = async (): Promise<void> => {
      await this.auditService.recordToolCall({
        requestId: input.approvalRequestId ?? randomUUID(),
        actor: input.setBy,
        toolName: AUTONOMY_MODE_CHANGE_TOOL_NAME,
        inputsHash: hashOf({ mode: input.mode, hours: input.hours }),
        planSummary: `modo de autonomía ${previous} -> ${input.mode} (${input.reason})${expiresAt ? `, hasta ${expiresAt.toISOString()}` : ''}`,
        approvalStatus: 'auto',
      });
    };

    if (input.auditBeforeApply) {
      await audit();
    }

    await this.db
      .update(autonomyModeState)
      .set({
        mode: input.mode,
        expiresAt,
        setBy: input.setBy,
        approvalRequestId: input.approvalRequestId,
        changedAt: now,
        relaxedCount: 0,
        windowStartedAt: now,
      })
      .where(eq(autonomyModeState.id, STATE_ROW_ID));

    if (!input.auditBeforeApply) {
      await audit().catch((err: unknown) =>
        this.logger.error(
          `No se pudo auditar el cambio de modo (${input.reason}), pero YA se aplicó: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }

    this.eventEmitter.emit(AUTONOMY_MODE_CHANGED_EVENT, {
      mode: input.mode,
      previousMode: previous,
      reason: input.reason,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      setBy: input.setBy,
    } satisfies AutonomyModeChangedEvent);
    return expiresAt ? expiresAt.toISOString() : null;
  }

  /**
   * Cuenta una acción autoejecutada en la ventana de 1 h, de forma atómica
   * (un solo UPDATE evalúa la ventana y suma; dos llamadas concurrentes no
   * pierden cuenta). Devuelve el conteo resultante.
   */
  private async bumpRelaxedCounter(): Promise<number> {
    const [row] = await this.db
      .update(autonomyModeState)
      .set({
        relaxedCount: sql`CASE WHEN ${autonomyModeState.windowStartedAt} < now() - interval '1 hour' THEN 1 ELSE ${autonomyModeState.relaxedCount} + 1 END`,
        windowStartedAt: sql`CASE WHEN ${autonomyModeState.windowStartedAt} < now() - interval '1 hour' THEN now() ELSE ${autonomyModeState.windowStartedAt} END`,
      })
      .where(eq(autonomyModeState.id, STATE_ROW_ID))
      .returning({ count: autonomyModeState.relaxedCount });
    return row?.count ?? 0;
  }
}
