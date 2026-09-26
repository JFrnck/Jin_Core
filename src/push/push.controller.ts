import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { OkResultDto } from '../common/dto/ok-result.dto';
import { PushService } from './push.service';
import { PushStore } from './push.store';
import { APNS_ENVIRONMENTS, PUSH_KINDS } from './push.types';

/**
 * Tokens de APNs en hexadecimal. Los de dispositivo miden 32 bytes; los de
 * Live Activity push-to-start, 128 (visto en iOS 26: 256 caracteres), y
 * Apple avisa que pueden crecer.
 */
const ApnsTokenSchema = z
  .string()
  .regex(/^[0-9a-f]{64,512}$/i, 'token de APNs inválido');

const RegisterDeviceSchema = z.object({
  token: ApnsTokenSchema,
  environment: z.enum(APNS_ENVIRONMENTS),
  /** Toggles de Ajustes de la app; lo no enviado usa el default del servidor. */
  preferences: z
    .record(z.string(), z.boolean())
    .refine(
      (prefs) =>
        Object.keys(prefs).every((key) =>
          (PUSH_KINDS as readonly string[]).includes(key),
        ),
      { message: `tipos válidos: ${PUSH_KINDS.join(', ')}` },
    )
    .default({}),
});
class RegisterDeviceDto extends createZodDto(RegisterDeviceSchema) {}

const RegisterActivityTokenSchema = z
  .object({
    /** 'update': una actividad en curso. 'start': iniciarlas por push (push-to-start). */
    purpose: z.enum(['update', 'start']),
    token: ApnsTokenSchema,
    environment: z.enum(APNS_ENVIRONMENTS),
    kind: z.string().min(1).max(40).optional(),
    referenceId: z.string().min(1).max(100).optional(),
  })
  .refine(
    (body) =>
      body.purpose === 'start' ||
      (body.kind !== undefined && body.referenceId !== undefined),
    { message: "'update' necesita kind y referenceId" },
  );
class RegisterActivityTokenDto extends createZodDto(
  RegisterActivityTokenSchema,
) {}

const PushStatusSchema = z.object({
  /** false hasta cargar las claves APNs (cuenta Apple Developer). */
  enabled: z.boolean(),
});
class PushStatusDto extends createZodDto(PushStatusSchema) {}

const PushTestResultSchema = z.object({
  enabled: z.boolean(),
  sent: z.number().int(),
  failed: z.number().int(),
});
class PushTestResultDto extends createZodDto(PushTestResultSchema) {}

/**
 * Registro de la app iOS para notificaciones push (ADR 0014). JWT del owner
 * (guard global). Guardar un token no decide nada: solo dice a dónde avisar.
 */
@ApiTags('push')
@Controller('api/push')
export class PushController {
  constructor(
    private readonly pushService: PushService,
    private readonly store: PushStore,
  ) {}

  @Get('status')
  @ApiOperation({ summary: '¿Está encendido push (claves APNs cargadas)?' })
  @ZodResponse({ status: 200, type: PushStatusDto })
  status(): { enabled: boolean } {
    return { enabled: this.pushService.enabled };
  }

  @Put('device')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Registra (o actualiza) este iPhone y sus preferencias',
  })
  @ZodResponse({ status: 200, type: OkResultDto })
  async registerDevice(@Body() body: RegisterDeviceDto): Promise<{ ok: true }> {
    await this.store.upsertDevice(body);
    return { ok: true };
  }

  @Delete('device/:token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deja de avisar a este iPhone (cerrar sesión)' })
  @ZodResponse({ status: 200, type: OkResultDto })
  async unregisterDevice(@Param('token') token: string): Promise<{ ok: true }> {
    await this.store.deleteDevice(token);
    return { ok: true };
  }

  @Put('activity')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Token de una Live Activity (update) o para iniciarlas por push (start)',
  })
  @ZodResponse({ status: 200, type: OkResultDto })
  async registerActivityToken(
    @Body() body: RegisterActivityTokenDto,
  ): Promise<{ ok: true }> {
    await this.store.upsertActivityToken(body);
    return { ok: true };
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Manda un aviso de prueba a los iPhones registrados',
  })
  @ZodResponse({ status: 200, type: PushTestResultDto })
  test(): Promise<{ enabled: boolean; sent: number; failed: number }> {
    return this.pushService.sendTest();
  }
}
