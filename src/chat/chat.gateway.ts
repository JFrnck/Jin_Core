import { Logger } from '@nestjs/common';
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error en turno de chat WS: ${message}`);
      client.emit('chat:error', { message });
    }
  }
}
