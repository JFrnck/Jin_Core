import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { dateCodec, nullableDateCodec } from '../common/dto/date-codec';
import { RunNotFoundError } from './errors';
import { LedgerRepository } from './ledger.repository';
import {
  AGENT_COMMENT_AUTHOR_TYPES,
  AGENT_COMMENT_KINDS,
  AGENT_RUN_STATUSES,
  AGENT_TICKET_STATUSES,
} from './orchestrator.types';

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(20),
  cursor: z.string().optional(),
});
class ListQueryDto extends createZodDto(ListQuerySchema) {}

// Board de orquestación (Fase 5.4/6.2): un run + sus tickets + el hilo de
// comentarios de cada uno, en una sola llamada — el board necesita todo
// junto para renderizar el tablero estilo Jira de una vez.
const RunSummarySchema = z.object({
  id: z.string(),
  objective: z.string(),
  status: z.enum(AGENT_RUN_STATUSES),
  parentSessionId: z.string(),
  finalResponse: z.string().nullable(),
  createdAt: dateCodec,
  completedAt: nullableDateCodec,
});

const TicketCommentSchema = z.object({
  id: z.string(),
  ticketId: z.string(),
  authorType: z.enum(AGENT_COMMENT_AUTHOR_TYPES),
  authorId: z.string().nullable(),
  kind: z.enum(AGENT_COMMENT_KINDS),
  body: z.string(),
});

const TicketSchema = z.object({
  id: z.string(),
  runId: z.string(),
  description: z.string(),
  status: z.enum(AGENT_TICKET_STATUSES),
  assignedSubAgentId: z.string().nullable(),
  allowedTools: z.array(z.string()),
  dependsOn: z.array(z.string()),
  result: z.string().nullable(),
  comments: z.array(TicketCommentSchema),
});

const ListRunsResponseSchema = z.object({
  items: z.array(RunSummarySchema),
  nextCursor: z.string().nullable(),
});
class ListRunsResponseDto extends createZodDto(ListRunsResponseSchema, {
  codec: true,
}) {}

const RunDetailResponseSchema = z.object({
  run: RunSummarySchema,
  tickets: z.array(TicketSchema),
});
class RunDetailResponseDto extends createZodDto(RunDetailResponseSchema, {
  codec: true,
}) {}
type RunDetailResponse = z.infer<typeof RunDetailResponseSchema>;

@ApiTags('orchestrator')
@Controller('api/orchestrator')
export class OrchestratorController {
  constructor(private readonly ledgerRepository: LedgerRepository) {}

  @Get('runs')
  @ApiOperation({
    summary: 'Runs de orquestación multi-agente, más reciente primero',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ZodResponse({ status: 200, type: ListRunsResponseDto })
  async listRuns(@Query() query: ListQueryDto) {
    const result = await this.ledgerRepository.listRuns({
      limit: query.limit,
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    });
    return { items: [...result.items], nextCursor: result.nextCursor };
  }

  @Get('runs/:runId')
  @ApiOperation({
    summary:
      'Detalle de un run: tickets + hilo de comentarios de cada uno (board de orquestación)',
  })
  @ZodResponse({ status: 200, type: RunDetailResponseDto })
  async getRun(@Param('runId') runId: string): Promise<RunDetailResponse> {
    const run = await this.ledgerRepository.getRun(runId);
    if (!run) {
      throw new RunNotFoundError(runId);
    }

    const tickets = await this.ledgerRepository.getTickets(runId);
    const ticketsWithComments = await Promise.all(
      tickets.map(async (ticket) => ({
        ...ticket,
        allowedTools: [...ticket.allowedTools],
        dependsOn: [...ticket.dependsOn],
        comments: await this.ledgerRepository.getComments(ticket.id),
      })),
    );

    return { run, tickets: ticketsWithComments };
  }
}
