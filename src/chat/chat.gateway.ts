import { Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { AgentService } from '../agent/agent.service';
import { extractWsToken } from '../auth/ws-token';
import {
  CHAT_TURN_FINISHED_EVENT,
  type ChatTurnFinishedEvent,
} from './chat.events';
import { ChatBodySchema, toModelMessages } from './model-message.schema';

const CHAT_ACTOR_LABEL = 'web-chat';

/**
 * Contraparte WS de `POST /api/chat` — mismo `AgentService.runTurn()`,
 * mismo body, sin persistencia server-side. A diferencia de `POST
 * /api/chat` (atómico), este gateway SÍ pasa `onProgress`: emite
 * `chat:progress` (plan/tool-call-started/tool-call-finished/text-delta,
 * ver `agent-progress.types.ts`) en vivo mientras el turno corre, además
 * del `chat:response`/`chat:error` final de siempre. Streaming exclusivo
 * de este namespace — Telegram y `POST /api/chat` no lo tocan.
 */
@WebSocketGateway({ namespace: '/chat' })
export class ChatGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly agentService: AgentService,
    private readonly jwtService: JwtService,
    // Opcional: los tests construyen el gateway sin él; en la app lo pone Nest.
    @Optional() private readonly eventEmitter?: EventEmitter2,
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

  @SubscribeMessage('chat:message')
  async handleMessage(
    @MessageBody() payload: unknown,
    @ConnectedSocket() client: Socket,
  ): Promise<void> {
    const parsed = ChatBodySchema.safeParse(payload);
    if (!parsed.success) {
      client.emit('chat:error', { message: 'Payload inválido.' });
      return;
    }

    try {
      const history = toModelMessages(parsed.data.history);
      const result = await this.agentService.runTurn({
        sessionId: parsed.data.sessionId,
        objective: parsed.data.objective,
        actorLabel: CHAT_ACTOR_LABEL,
        ...(history !== undefined ? { history } : {}),
        onProgress: (event) => client.emit('chat:progress', event),
      });
      client.emit('chat:response', result);
      this.notifyIfGone(client, parsed.data, true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error en turno de chat WS: ${message}`);
      client.emit('chat:error', { message });
      this.notifyIfGone(client, parsed.data, false);
    }
  }

  /**
   * Si la app lo pidió y ya no está escuchando, el resultado se perdería en
   * silencio: se avisa por push para que el owner vuelva a abrirla.
   */
  private notifyIfGone(
    client: Socket,
    body: {
      sessionId: string;
      objective: string;
      notifyWhenDone?: boolean | undefined;
    },
    ok: boolean,
  ): void {
    if (!body.notifyWhenDone || client.connected) return;
    const event: ChatTurnFinishedEvent = {
      sessionId: body.sessionId,
      objective: body.objective,
      ok,
    };
    this.eventEmitter?.emit(CHAT_TURN_FINISHED_EVENT, event);
  }
}
