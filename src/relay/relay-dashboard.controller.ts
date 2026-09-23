import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { RelayService } from './relay.service';
import { MAX_BODY_LENGTH } from './relay.types';

// Mismo patrón que orchestrator.controller.ts/audit.controller.ts:
// `z.coerce` + `.default()` hace que un `limit` ausente o basura no rompa
// nada (el `ZodValidationPipe` global lo valida/coacciona antes de llegar
// acá), y el `@ApiQuery({ required: false })` de abajo es necesario aparte
// -- sin él, Swagger infiere el query param como obligatorio igual.
const RelayHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
});
class RelayHistoryQueryDto extends createZodDto(RelayHistoryQuerySchema) {}

const RelayHistoryMessageSchema = z.object({
  id: z.string(),
  direction: z.enum(['in', 'out']),
  body: z.string(),
  // Ver el comentario de `RelayHistoryMessage.bodyHtml` (relay.types.ts):
  // markdown ya renderizado server-side, seguro para dangerouslySetInnerHTML.
  bodyHtml: z.string(),
  options: z.array(z.string()).optional(),
  answerTo: z.string().optional(),
  createdAt: z.string(),
});
const RelayHistorySchema = z.object({
  messages: z.array(RelayHistoryMessageSchema),
});
class RelayHistoryDto extends createZodDto(RelayHistorySchema) {}

const RelayReplySchema = z.object({
  body: z.string().min(1).max(MAX_BODY_LENGTH),
  /** Presente si esta respuesta contesta una pregunta puntual de Claude. */
  answerTo: z.string().uuid().optional(),
});
class RelayReplyDto extends createZodDto(RelayReplySchema) {}

const RelayReplyCreatedSchema = z.object({ id: z.string() });
class RelayReplyCreatedDto extends createZodDto(RelayReplyCreatedSchema) {}

/**
 * Segundo canal del puente Claude Code ↔ owner (ADR 0012), esta vez para el
 * dashboard en vez del CLI de la VM. A diferencia de `RelayController`
 * (`/api/relay/*`, bloqueado del internet público por
 * `middleware-deny-public.yaml` — frontera de `RELAY_TOKEN`), este vive bajo
 * `/api/bridge` a propósito: cualquier prefix que empiece con `/api/relay`
 * cae bajo esa regla de Traefik y el navegador del owner nunca lo alcanzaría.
 *
 * Sin `@Public()` ni guard propio: hereda el `JwtAuthGuard` global
 * (`app.module.ts`), la misma frontera de confianza que ya protege
 * `/api/hitl`, `/api/chat` y `/api/budget` — el owner autenticado, no una
 * superficie nueva.
 */
@ApiTags('relay')
@Controller('api/bridge')
export class RelayDashboardController {
  constructor(private readonly relayService: RelayService) {}

  @Get('messages')
  @ApiOperation({
    summary:
      'Historial del puente para el dashboard (ambas direcciones) — lectura pura, no consume la cola que lee el CLI de la VM',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ZodResponse({ status: 200, type: RelayHistoryDto })
  async messages(
    @Query() query: RelayHistoryQueryDto,
  ): Promise<z.infer<typeof RelayHistorySchema>> {
    const messages = await this.relayService.history(query.limit);
    // Copia superficial: `RelayHistoryMessage.options` es `readonly string[]`
    // (relay.types.ts) — el array mutable que exige la firma de
    // `@ZodResponse` es solo un detalle de tipos en el borde HTTP, mismo
    // criterio que `chat.controller.ts`.
    return {
      messages: messages.map(({ options, ...rest }) => ({
        ...rest,
        ...(options !== undefined ? { options: [...options] } : {}),
      })),
    };
  }

  @Post('reply')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'El owner responde a Claude desde el dashboard — mismo rol que una respuesta por Telegram',
  })
  @ZodResponse({ status: 201, type: RelayReplyCreatedDto })
  async reply(
    @Body() body: RelayReplyDto,
  ): Promise<z.infer<typeof RelayReplyCreatedSchema>> {
    return this.relayService.reply({
      body: body.body,
      ...(body.answerTo !== undefined ? { answerTo: body.answerTo } : {}),
    });
  }
}
