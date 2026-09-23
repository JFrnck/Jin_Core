import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Cron } from '@nestjs/schedule';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { extractWsToken } from '../auth/ws-token';
import { BudgetService } from '../budget/budget.service';
import { KillSwitchService } from '../budget/kill-switch.service';
import {
  PENDING_APPROVAL_CREATED_EVENT,
  type PendingApprovalCreatedEvent,
} from '../hitl/dual-confirm.service';
import {
  RELAY_MESSAGE_CREATED_EVENT,
  type RelayMessageCreatedEvent,
} from '../relay/relay.service';

// Mismos umbrales que `TelegramBotService.checkDailyBudgetAlert()` (Fase
// 4.1) — repetido acá a propósito, no extraído a un servicio compartido:
// con Telegram + este gateway son 2 consumidores del mismo sondeo, no los
// 3 que AGENTS.md 1.1 pide ver antes de abstraer.
const DAILY_ALERT_THRESHOLDS = [0.8, 1] as const;

/**
 * Eventos híbridos (Fase 6.1, ADR 0007 decisión #5):
 * `pending-approval:new` es genuinamente push, vía el único emit point
 * real en `DualConfirmService.createPendingApproval()`. `budget:alert` /
 * `kill-switch:activated` son polling disfrazado de push — mismo patrón
 * exacto que `TelegramBotService.checkBudgetAlerts()`, replicado acá en
 * vez de extraído a un servicio compartido (mismo criterio de arriba).
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  private readonly notifiedDailyThresholdsToday = new Set<number>();
  private lastDailyThresholdResetDate = '';
  private lastNotifiedKillSwitchActive = false;

  constructor(
    private readonly jwtService: JwtService,
    private readonly budgetService: BudgetService,
    private readonly killSwitchService: KillSwitchService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = extractWsToken(client);
    if (!token) {
      client.disconnect(true);
      return;
    }

    try {
      await this.jwtService.verifyAsync(token);
    } catch {
      client.disconnect(true);
    }
  }

  @OnEvent(PENDING_APPROVAL_CREATED_EVENT)
  handlePendingApprovalCreated(event: PendingApprovalCreatedEvent): void {
    this.server.emit('pending-approval:new', event);
  }

  // Puente Claude Code ↔ owner (ADR 0012): un mensaje nuevo en cualquier
  // dirección (Claude → owner por Telegram/CLI, u owner → Claude desde el
  // dashboard) empuja esto para que `/bridge` se actualice sin polling.
  @OnEvent(RELAY_MESSAGE_CREATED_EVENT)
  handleRelayMessageCreated(event: RelayMessageCreatedEvent): void {
    this.server.emit('bridge:new-message', event);
  }

  @Cron('*/5 * * * *')
  async checkBudgetAlerts(): Promise<void> {
    try {
      await this.checkKillSwitchAlert();
      await this.checkDailyBudgetAlert();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Error chequeando alertas de budget/kill-switch: ${message}`,
      );
    }
  }

  private async checkKillSwitchAlert(): Promise<void> {
    const isActive = await this.killSwitchService.isActive();
    if (isActive && !this.lastNotifiedKillSwitchActive) {
      this.server.emit('kill-switch:activated', {});
    }
    this.lastNotifiedKillSwitchActive = isActive;
  }

  private async checkDailyBudgetAlert(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastDailyThresholdResetDate) {
      this.notifiedDailyThresholdsToday.clear();
      this.lastDailyThresholdResetDate = today;
    }

    const ratio = await this.budgetService.getDailyUsageRatio();
    for (const threshold of DAILY_ALERT_THRESHOLDS) {
      if (
        ratio >= threshold &&
        !this.notifiedDailyThresholdsToday.has(threshold)
      ) {
        this.notifiedDailyThresholdsToday.add(threshold);
        this.server.emit('budget:alert', { ratio, threshold });
      }
    }
  }
}
