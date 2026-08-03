import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AgentService } from '../agent/agent.service';
import type { AgentTurnResult } from '../agent/agent.types';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  ChatBodySchema,
  toModelMessages,
  type ChatBody,
} from './model-message.schema';

// Atribución en audit_log/pendingApprovals (mismo campo que usa el
// orquestador, Fase 5.4) — distingue estos turnos de los de Telegram
// ('agent' por default) en el audit log.
const CHAT_ACTOR_LABEL = 'web-chat';

@ApiTags('chat')
@Controller('api/chat')
export class ChatController {
  constructor(private readonly agentService: AgentService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Turno de chat contra el agente — sin persistencia de sesión server-side, el caller manda su propio historial',
  })
  async chat(
    @Body(new ZodValidationPipe(ChatBodySchema)) body: ChatBody,
  ): Promise<AgentTurnResult> {
    const history = toModelMessages(body.history);
    return this.agentService.runTurn({
      sessionId: body.sessionId,
      objective: body.objective,
      actorLabel: CHAT_ACTOR_LABEL,
      ...(history !== undefined ? { history } : {}),
    });
  }
}
