import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { AgentService } from '../agent/agent.service';
import { AgentStepStatusSchema } from '../agent/agent.types';
import { ChatDto, toModelMessages } from './model-message.schema';

const AgentStepSchema = z.object({
  description: z.string(),
  status: AgentStepStatusSchema,
  note: z.string().optional(),
});

const AgentTurnResultSchema = z.object({
  finalResponse: z.string(),
  plan: z.object({ steps: z.array(AgentStepSchema) }),
  pendingApprovals: z.array(
    z.object({ requestId: z.string(), toolName: z.string() }),
  ),
  iterationsUsed: z.number(),
});
class AgentTurnResultDto extends createZodDto(AgentTurnResultSchema) {}
type AgentTurnResultResponse = z.infer<typeof AgentTurnResultSchema>;

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
  @ZodResponse({ status: 200, type: AgentTurnResultDto })
  async chat(@Body() body: ChatDto): Promise<AgentTurnResultResponse> {
    const history = toModelMessages(body.history);
    const result = await this.agentService.runTurn({
      sessionId: body.sessionId,
      objective: body.objective,
      actorLabel: CHAT_ACTOR_LABEL,
      ...(history !== undefined ? { history } : {}),
    });
    // Copias superficiales: `AgentTurnResult` declara `readonly T[]` en
    // `plan.steps`/`pendingApprovals` (`agent.types.ts`) — el array
    // mutable que exige la firma de `@ZodResponse` es solo un detalle de
    // tipos en el borde HTTP, no un cambio de contrato del agent loop.
    return {
      finalResponse: result.finalResponse,
      plan: { steps: [...result.plan.steps] },
      pendingApprovals: [...result.pendingApprovals],
      iterationsUsed: result.iterationsUsed,
    };
  }
}
