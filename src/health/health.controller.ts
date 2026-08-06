import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { Public } from '../auth/public.decorator';
import { HealthService } from './health.service';

const HealthReportSchema = z.object({
  status: z.enum(['ok', 'degraded', 'error']),
  postgres: z.enum(['up', 'down']),
  redis: z.enum(['up', 'down']),
});
class HealthReportDto extends createZodDto(HealthReportSchema) {}

/**
 * `@Public()` porque el kubelet no tiene JWT, y `@SkipThrottle()` porque
 * el rate limit global es de 60 req/min por IP (ADR 0007 decisión #4):
 * las probes salen todas de la IP del nodo y cada sondeo consumiría de
 * ese mismo presupuesto. Una probe que recibe 429 se reporta como pod
 * caído — peor que no tenerla.
 */
@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Public()
  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Liveness — el proceso responde. No consulta dependencias a propósito: reiniciar el pod no arregla un Postgres caído.',
  })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  @ApiOperation({
    summary:
      'Readiness — 200 si el pod puede servir, 503 si no. Postgres es dependencia dura; Redis solo degrada (fail-open, ADR 0007).',
  })
  @ApiResponse({ status: 503, description: 'Postgres no responde' })
  @ZodResponse({
    status: 200,
    type: HealthReportDto,
    description:
      'status "ok" (todo arriba) o "degraded" (Redis caído, se sigue sirviendo)',
  })
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<z.infer<typeof HealthReportSchema>> {
    const report = await this.healthService.check();
    if (report.status === 'error') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return report;
  }
}
