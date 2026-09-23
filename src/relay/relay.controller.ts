import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { Public } from '../auth/public.decorator';
import { RelayDisabledError } from './errors';
import { RelayService } from './relay.service';
import { RelayTokenGuard } from './relay-token.guard';
import { MAX_BODY_LENGTH, MAX_OPTIONS } from './relay.types';

const SendRelayMessageSchema = z.object({
  // Ver el comentario de MAX_BODY_LENGTH: no es el límite de Telegram (ese
  // ya lo maneja `RelayBotService.deliver()` troceando), es solo una cota
  // de sanidad para el payload.
  body: z.string().min(1).max(MAX_BODY_LENGTH),
  /**
   * Con opciones, el owner recibe botones y su respuesta queda correlacionada
   * con esta pregunta. Sin opciones, es un aviso suelto.
   */
  options: z
    .array(z.string().min(1).max(64))
    .min(1)
    .max(MAX_OPTIONS)
    .optional(),
});
class SendRelayMessageDto extends createZodDto(SendRelayMessageSchema) {}

const RelayMessageCreatedSchema = z.object({ id: z.string() });
class RelayMessageCreatedDto extends createZodDto(RelayMessageCreatedSchema) {}

const RelayInboxSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      body: z.string(),
      answerTo: z.string().optional(),
      createdAt: z.string(),
    }),
  ),
});
class RelayInboxDto extends createZodDto(RelayInboxSchema) {}

const RelayAnswerSchema = z.object({
  answered: z.boolean(),
  body: z.string().optional(),
  answeredAt: z.string().optional(),
});
class RelayAnswerDto extends createZodDto(RelayAnswerSchema) {}

/**
 * Puente Claude Code ↔ owner (ADR 0012).
 *
 * `@Public()` lo exime del JWT global, pero NO lo deja abierto: `RelayTokenGuard`
 * exige el `RELAY_TOKEN`. Son dos credenciales distintas a propósito — el token
 * del puente solo sirve para mensajería.
 *
 * Este controller no expone ninguna operación de HITL, y el módulo no inyecta
 * los servicios que las harían posibles (ver `relay.module.ts`).
 */
@ApiTags('relay')
@Controller('api/relay')
@Public()
@UseGuards(RelayTokenGuard)
export class RelayController {
  constructor(private readonly relayService: RelayService) {}

  @Post('messages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Manda un mensaje (o una pregunta con opciones) del Claude de la VM al owner',
  })
  @ZodResponse({ status: 201, type: RelayMessageCreatedDto })
  async send(
    @Body() body: SendRelayMessageDto,
  ): Promise<z.infer<typeof RelayMessageCreatedSchema>> {
    this.assertEnabled();
    return this.relayService.send({
      body: body.body,
      ...(body.options !== undefined ? { options: body.options } : {}),
    });
  }

  @Get('inbox')
  @ApiOperation({
    summary:
      'Mensajes del owner pendientes de leer — los devuelve UNA sola vez (los marca consumidos)',
  })
  @ZodResponse({ status: 200, type: RelayInboxDto })
  async inbox(): Promise<z.infer<typeof RelayInboxSchema>> {
    this.assertEnabled();
    return { messages: await this.relayService.inbox() };
  }

  @Get('messages/:id/answer')
  @ApiOperation({
    summary:
      'Respuesta del owner a una pregunta concreta (para el modo espera)',
  })
  @ZodResponse({ status: 200, type: RelayAnswerDto })
  async answer(
    // Sin validar, un id basura llega crudo a Postgres ("invalid input syntax
    // for type uuid") y sale como un 500. Es un 400: el error es del cliente.
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<z.infer<typeof RelayAnswerSchema>> {
    this.assertEnabled();
    return this.relayService.answer(id);
  }

  /**
   * El guard ya cubre el caso de `RELAY_TOKEN` ausente. Esto cubre el otro
   * medio arranque: token puesto pero bot sin token, en el que aceptar el
   * mensaje y no entregarlo sería peor que rechazarlo.
   */
  private assertEnabled(): void {
    if (!this.relayService.enabled) throw new RelayDisabledError();
  }
}
