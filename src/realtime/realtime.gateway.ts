import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { extractWsToken } from '../auth/ws-token';
import {
  BUDGET_THRESHOLD_CROSSED_EVENT,
  KILL_SWITCH_ACTIVATED_EVENT,
  type BudgetThresholdCrossedEvent,
} from '../budget/budget-alert.monitor';
import {
  PENDING_APPROVAL_CREATED_EVENT,
  type PendingApprovalCreatedEvent,
} from '../hitl/dual-confirm.service';
import {
  RELAY_MESSAGE_CREATED_EVENT,
  type RelayMessageCreatedEvent,
} from '../relay/relay.service';

/**
 * Eventos híbridos (Fase 6.1, ADR 0007 decisión #5):
 * `pending-approval:new` es genuinamente push, vía el único emit point
 * real en `DualConfirmService.createPendingApproval()`. `budget:alert` /
 * `kill-switch:activated` son polling disfrazado de push: el sondeo vive en
 * `BudgetAlertMonitor` (compartido con las notificaciones push, ADR 0014) y
 * acá solo se reenvía.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayConnection {
  @WebSocketServer()
  private readonly server!: Server;

  constructor(private readonly jwtService: JwtService) {}

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

  @OnEvent(KILL_SWITCH_ACTIVATED_EVENT)
  handleKillSwitchActivated(): void {
    this.server.emit('kill-switch:activated', {});
  }

  @OnEvent(BUDGET_THRESHOLD_CROSSED_EVENT)
  handleBudgetThresholdCrossed(event: BudgetThresholdCrossedEvent): void {
    this.server.emit('budget:alert', {
      ratio: event.ratio,
      threshold: event.threshold,
    });
  }
}
