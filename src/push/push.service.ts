import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { LedgerRepository } from '../agent/ledger.repository';
import {
  ORCHESTRATION_RUN_CHANGED_EVENT,
  type OrchestrationRunChangedEvent,
} from '../agent/orchestrator.events';
import {
  BUDGET_THRESHOLD_CROSSED_EVENT,
  KILL_SWITCH_ACTIVATED_EVENT,
  type BudgetThresholdCrossedEvent,
  type KillSwitchActivatedEvent,
} from '../budget/budget-alert.monitor';
import {
  CHAT_TURN_FINISHED_EVENT,
  type ChatTurnFinishedEvent,
} from '../chat/chat.events';
import type { Env } from '../config/env.schema';
import { DB_CONNECTION, type Db } from '../db/db.module';
import { pendingApprovals, relayMessages } from '../db/schema';
import {
  PENDING_APPROVAL_CREATED_EVENT,
  type PendingApprovalCreatedEvent,
} from '../hitl/dual-confirm.service';
import {
  HITL_ACTION_NOTIFIED_EVENT,
  type HitlActionNotifiedEvent,
} from '../hitl/notify.events';
import {
  HITL_APPROVAL_ESCALATED_EVENT,
  type HitlApprovalTimeoutEvent,
} from '../hitl/timeout.service';
import {
  MORNING_ALERT_EVENT,
  type MorningAlertEvent,
} from '../integrations/canvas/morning-alert.events';
import {
  RELAY_MESSAGE_CREATED_EVENT,
  type RelayMessageCreatedEvent,
} from '../relay/relay.service';
import { ApnsClient } from './apns.client';
import {
  approvalExpiringPayload,
  approvalNewPayload,
  bridgeMessagePayload,
  budgetPayload,
  chatDonePayload,
  killSwitchContentState,
  killSwitchPayload,
  liveActivityStartPayload,
  liveActivityUpdatePayload,
  morningSummaryPayload,
  notifyExecutedPayload,
  orchestrationContentState,
  testPayload,
  type OrchestrationSnapshot,
} from './push.payloads';
import { PushStore } from './push.store';
import {
  wantsKind,
  type ApnsEnvironment,
  type ApnsNotification,
  type PushKind,
} from './push.types';

/**
 * Notificaciones push de la app iOS (ADR 0014).
 *
 * Sin `APNS_KEY_ID`/`APNS_TEAM_ID`/`APNS_PRIVATE_KEY` (hasta que haya cuenta
 * Apple Developer) queda APAGADO: los eventos se ignoran y Jin funciona igual.
 * Solo avisa: nunca aprueba, rechaza ni escribe en `audit_log`. Un fallo al
 * enviar se loguea y jamás se propaga al emisor del evento.
 */
@Injectable()
export class PushService implements OnModuleDestroy {
  private readonly logger = new Logger(PushService.name);
  private readonly client: ApnsClient | null;

  constructor(
    configService: ConfigService<Env, true>,
    private readonly store: PushStore,
    private readonly ledger: LedgerRepository,
    @Inject(DB_CONNECTION) private readonly db: Db,
  ) {
    const keyId = configService.get('APNS_KEY_ID', { infer: true });
    const teamId = configService.get('APNS_TEAM_ID', { infer: true });
    const privateKeyPem = configService.get('APNS_PRIVATE_KEY', {
      infer: true,
    });
    const bundleId = configService.get('APNS_BUNDLE_ID', { infer: true });
    this.client =
      keyId && teamId && privateKeyPem
        ? new ApnsClient({ keyId, teamId, privateKeyPem, bundleId })
        : null;
    if (!this.client) {
      this.logger.log(
        'Push apagado: faltan las claves APNs (cuenta Apple Developer).',
      );
    }
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  onModuleDestroy(): void {
    this.client?.close();
  }

  // MARK: - Eventos → avisos

  @OnEvent(PENDING_APPROVAL_CREATED_EVENT)
  async onApprovalCreated(event: PendingApprovalCreatedEvent): Promise<void> {
    await this.guard('approval_new', async () => {
      const [row] = await this.db
        .select({ planSummary: pendingApprovals.planSummary })
        .from(pendingApprovals)
        .where(eq(pendingApprovals.requestId, event.requestId));
      return approvalNewPayload({
        requestId: event.requestId,
        toolName: event.toolName,
        level: event.level,
        planSummary: row?.planSummary ?? null,
      });
    });
  }

  @OnEvent(HITL_APPROVAL_ESCALATED_EVENT)
  async onApprovalEscalated(event: HitlApprovalTimeoutEvent): Promise<void> {
    await this.guard('approval_expiring', () => approvalExpiringPayload(event));
  }

  @OnEvent(HITL_ACTION_NOTIFIED_EVENT)
  async onActionNotified(event: HitlActionNotifiedEvent): Promise<void> {
    await this.guard('notify_executed', () =>
      notifyExecutedPayload({
        toolName: event.toolName,
        ...(event.relaxedBy !== undefined
          ? { relaxedBy: event.relaxedBy }
          : {}),
      }),
    );
  }

  @OnEvent(BUDGET_THRESHOLD_CROSSED_EVENT)
  async onBudgetThreshold(event: BudgetThresholdCrossedEvent): Promise<void> {
    await this.guard('budget', () => budgetPayload(event));
  }

  @OnEvent(KILL_SWITCH_ACTIVATED_EVENT)
  async onKillSwitch(event: KillSwitchActivatedEvent): Promise<void> {
    await this.guard('kill_switch', () => killSwitchPayload(event));
    // Live Activity del kill switch con la app cerrada (push-to-start).
    await this.safely('kill-switch live activity', () =>
      this.startActivity({
        kind: 'killSwitch',
        referenceId: 'kill',
        notification: liveActivityStartPayload({
          kind: 'killSwitch',
          referenceId: 'kill',
          state: killSwitchContentState(event),
          alert: {
            title: '❄ Agentes congelados',
            body: 'Kill switch activado.',
          },
        }),
      }),
    );
  }

  @OnEvent(RELAY_MESSAGE_CREATED_EVENT)
  async onRelayMessage(event: RelayMessageCreatedEvent): Promise<void> {
    // Solo Claude → owner; lo que escribe el owner no se le notifica a sí mismo.
    if (event.direction !== 'out') return;
    await this.guard('bridge_message', async () => {
      const [row] = await this.db
        .select({ body: relayMessages.body, options: relayMessages.options })
        .from(relayMessages)
        .where(eq(relayMessages.id, event.id));
      return row
        ? bridgeMessagePayload({
            id: event.id,
            body: row.body,
            options: row.options,
          })
        : null;
    });
  }

  @OnEvent(MORNING_ALERT_EVENT)
  async onMorningAlert(event: MorningAlertEvent): Promise<void> {
    await this.guard('morning_summary', () => morningSummaryPayload(event));
  }

  @OnEvent(CHAT_TURN_FINISHED_EVENT)
  async onChatTurnFinished(event: ChatTurnFinishedEvent): Promise<void> {
    await this.guard('chat_done', () =>
      chatDonePayload({
        conversationId: event.sessionId,
        objective: event.objective,
        ok: event.ok,
      }),
    );
  }

  @OnEvent(ORCHESTRATION_RUN_CHANGED_EVENT)
  async onRunChanged(event: OrchestrationRunChangedEvent): Promise<void> {
    if (!this.enabled) return;
    await this.safely('orchestration live activity', async () => {
      const snapshot = await this.orchestrationSnapshot(event.runId);
      if (!snapshot) return;
      const state = orchestrationContentState(snapshot);
      const tokens = await this.store.activityTokensFor(event.runId);

      if (tokens.length === 0) {
        // Recién creado y la app no lo sigue todavía: se inicia por push.
        if (
          state.phase === 'running' &&
          state.segments.every((s) => s === 'pending')
        ) {
          await this.startActivity({
            kind: 'orchestration',
            referenceId: event.runId,
            notification: liveActivityStartPayload({
              kind: 'orchestration',
              referenceId: event.runId,
              state,
              alert: {
                title: 'Jin reparte el trabajo',
                body: snapshot.run.objective,
              },
            }),
          });
        }
        return;
      }

      const finished = state.phase === 'done' || state.phase === 'failed';
      const notification = liveActivityUpdatePayload({
        kind: 'orchestration',
        state,
        // "hecho" se expande y se va a los 4 s; un fallo se queda hasta abrirlo (§10).
        ...(state.phase === 'done' ? { end: { dismissAfterSeconds: 4 } } : {}),
        ...(state.phase === 'conflict'
          ? {
              alert: {
                title: 'Conflicto',
                body: 'Un sub-agente necesita tu decisión',
              },
            }
          : finished
            ? {
                alert: {
                  title:
                    state.phase === 'done' ? 'Terminado' : 'Terminó con fallos',
                  body: state.title,
                },
              }
            : {}),
      });
      for (const token of tokens) {
        const result = await this.client!.send(
          token.environment as ApnsEnvironment,
          token.token,
          notification,
        );
        if (!result.ok && result.invalidToken)
          await this.store.deleteActivityToken(token.token);
      }
    });
  }

  // MARK: - Prueba (solo owner, desde Ajustes o el runbook de activación)

  async sendTest(): Promise<{
    enabled: boolean;
    sent: number;
    failed: number;
  }> {
    if (!this.client) return { enabled: false, sent: 0, failed: 0 };
    const { sent, failed } = await this.broadcast(null, testPayload());
    return { enabled: true, sent, failed };
  }

  // MARK: - Internos

  /** Construye el aviso y lo manda a los dispositivos que quieren ese tipo. */
  private async guard(
    kind: PushKind,
    build: () => ApnsNotification | null | Promise<ApnsNotification | null>,
  ): Promise<void> {
    if (!this.enabled) return;
    await this.safely(kind, async () => {
      const notification = await build();
      if (notification) await this.broadcast(kind, notification);
    });
  }

  private async broadcast(
    kind: PushKind | null,
    notification: ApnsNotification,
  ): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const device of await this.store.listDevices()) {
      if (kind && !wantsKind(device.preferences, kind)) continue;
      const result = await this.client!.send(
        device.environment as ApnsEnvironment,
        device.token,
        notification,
      );
      if (result.ok) {
        sent += 1;
        continue;
      }
      failed += 1;
      this.logger.warn(
        `APNs rechazó un aviso (${result.status} ${result.reason}).`,
      );
      if (result.invalidToken) await this.store.deleteDevice(device.token);
    }
    return { sent, failed };
  }

  private async startActivity(input: {
    kind: string;
    referenceId: string;
    notification: ApnsNotification;
  }): Promise<void> {
    for (const token of await this.store.startTokens()) {
      const result = await this.client!.send(
        token.environment as ApnsEnvironment,
        token.token,
        input.notification,
      );
      if (!result.ok && result.invalidToken)
        await this.store.deleteActivityToken(token.token);
    }
  }

  private async orchestrationSnapshot(
    runId: string,
  ): Promise<OrchestrationSnapshot | null> {
    const run = await this.ledger.getRun(runId);
    if (!run) return null;
    const tickets = await this.ledger.getTickets(runId);
    const withComments = await Promise.all(
      tickets.map(async (ticket) => {
        const comments = await this.ledger.getComments(ticket.id);
        const conflicts = comments.filter((c) => c.kind === 'conflict');
        return {
          description: ticket.description,
          status: ticket.status,
          assignedSubAgentId: ticket.assignedSubAgentId,
          commentKinds: comments.map((c) => c.kind),
          lastConflictBody: conflicts[conflicts.length - 1]?.body ?? null,
        };
      }),
    );
    return {
      run: {
        objective: run.objective,
        status: run.status,
        createdAt: run.createdAt,
        completedAt: run.completedAt,
      },
      tickets: withComments,
    };
  }

  /** Push nunca rompe el flujo que emitió el evento. */
  private async safely(
    label: string,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Push (${label}) falló: ${message}`);
    }
  }
}
