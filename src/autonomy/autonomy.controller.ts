import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { AutonomyService, type ModeChangeResult } from './autonomy.service';
import { AutonomyModeSchema } from './autonomy.types';

const ModeLimitsSchema = z.object({
  defaultHours: z.number(),
  maxHours: z.number(),
});

const AutonomyStatusSchema = z.object({
  mode: AutonomyModeSchema,
  expiresAt: z.string().nullable(),
  remainingSeconds: z.number().nullable(),
  setBy: z.string(),
  limits: z.object({
    semiAuto: ModeLimitsSchema,
    auto: ModeLimitsSchema,
    maxRelaxedActionsPerHour: z.number(),
  }),
  guardedInSemiAuto: z.array(z.string()),
});
class AutonomyStatusDto extends createZodDto(AutonomyStatusSchema) {}

const ChangeModeBodySchema = z.object({
  mode: AutonomyModeSchema,
  // Horas que dura el modo relajado antes de volver solo a `supervised`.
  // Se acota contra `config/autonomy.yaml`; sin valor usa el default del modo.
  hours: z.number().int().positive().optional(),
});
class ChangeModeDto extends createZodDto(ChangeModeBodySchema) {}

const ChangeModeResultSchema = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('applied'),
      mode: AutonomyModeSchema,
      expiresAt: z.string().nullable(),
    }),
    z.object({
      status: z.literal('pending-approval'),
      requestId: z.string(),
      mode: AutonomyModeSchema,
      hours: z.number(),
    }),
  ])
  .meta({ id: 'ChangeModeResult' });
const ChangeModeResultDto = createZodDto(ChangeModeResultSchema);
// Ver el mismo comentario en src/hitl/hitl.controller.ts: sin nombre propio,
// dos DTOs de unión anónimos comparten "AugmentedZodDto" y Swagger deja solo uno.
Object.defineProperty(ChangeModeResultDto, 'name', {
  value: 'ChangeModeResultDto',
});

// Sistema single-user (BLUEPRINT 5.2): mismo `actor` que ya usan HitlController/Telegram.
const REQUESTED_BY = 'owner:api';

/**
 * Interruptor de autonomía del HITL (ADR 0010). Protegido por el
 * `JwtAuthGuard` global: solo el owner autenticado. El LLM no tiene ninguna
 * tool que llegue acá.
 */
@ApiTags('autonomy')
@Controller('api/autonomy')
export class AutonomyController {
  constructor(private readonly autonomyService: AutonomyService) {}

  @Get()
  @ApiOperation({ summary: 'Modo de autonomía vigente, caducidad y límites' })
  @ZodResponse({ status: 200, type: AutonomyStatusDto })
  async getStatus() {
    return this.autonomyService.describe();
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cambia el modo. Volver a más restrictivo es inmediato; bajar la protección crea una aprobación dual-confirm (2 aprobaciones ≥30 s)',
  })
  @ZodResponse({ status: 200, type: ChangeModeResultDto })
  async changeMode(@Body() body: ChangeModeDto): Promise<ModeChangeResult> {
    return this.autonomyService.requestModeChange({
      mode: body.mode,
      ...(body.hours !== undefined ? { hours: body.hours } : {}),
      requestedBy: REQUESTED_BY,
    });
  }
}
