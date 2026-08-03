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
 * mismo body, sin persistencia server-side. La respuesta llega completa
 * cuando el turno termina, no token por token: `ModelCompletionResponse`
 * no soporta streaming hoy (hallazgo real, ver ADR 0007).
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
      });
      client.emit('chat:response', result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error en turno de chat WS: ${message}`);
      client.emit('chat:error', { message });
    }
  }
}
