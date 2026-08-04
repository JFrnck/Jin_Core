import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { OkResultDto } from '../common/dto/ok-result.dto';
import { ExecutorClientService } from './executor-client.service';

// Espejo de `PreviewServiceInfo` (`executor-client.service.ts`) — sin
// Date/bigint, todo ya llega como string plano desde el Executor real.
const PreviewServiceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  url: z.string(),
  status: z.enum(['running', 'expired']),
  expiresAt: z.string(),
});
class PreviewServiceDto extends createZodDto(PreviewServiceSchema) {}

/**
 * Fase 6.2/6.3: mismo cliente (`ExecutorClientService`) que ya usa
 * `listPreviewServices`/`stopPreviewService` como tools del agent loop
 * (`executor-client.module.ts`) — acá solo se expone vía REST para el
 * panel "Preview apps" del dashboard, sin lógica nueva.
 */
@ApiTags('preview-services')
@Controller('api/preview-services')
export class PreviewServicesController {
  constructor(private readonly executorClientService: ExecutorClientService) {}

  @Get()
  @ApiOperation({ summary: 'Apps de preview corriendo (jinserver.com)' })
  @ZodResponse({ status: 200, type: [PreviewServiceDto] })
  async list(): Promise<
    {
      id: string;
      slug: string;
      url: string;
      status: 'running' | 'expired';
      expiresAt: string;
    }[]
  > {
    return [...(await this.executorClientService.listPreviewServices())];
  }

  @Delete(':serviceId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Detiene una preview app antes de su TTL' })
  @ZodResponse({ status: 200, type: OkResultDto })
  async stop(@Param('serviceId') serviceId: string): Promise<{ ok: true }> {
    await this.executorClientService.stopPreviewService(serviceId);
    return { ok: true };
  }
}
