import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { computeInputsHash } from '../agent/agent.logic';
import { AuditService } from '../audit/audit.service';
import { OkResultDto } from '../common/dto/ok-result.dto';
import { ExecutorClientService } from './executor-client.service';
import { OwnerPreviewPublishService } from './owner-preview-publish.service';

// Espejo de `PreviewServiceInfo` (`executor-client.service.ts`) — sin
// Date/bigint, todo ya llega como string plano desde el Executor real.
const PreviewServiceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  url: z.string(),
  status: z.enum(['running', 'expired']),
  expiresAt: z.string(),
  /** Aprobación que lo originó (enlace con el audit); ausente en pods anteriores. */
  requestId: z.string().optional(),
  /** Motor de base de datos de la demo (sqlite | redis | postgres | mongodb), si pidió uno. */
  db: z.string().optional(),
});
class PreviewServiceDto extends createZodDto(PreviewServiceSchema) {}

/**
 * Tope del proyecto que publica el owner desde el editor del iPhone (ADR
 * 0015): una app de pocos archivos, no un repo. El Executor mete los archivos
 * en un env var de K8s, así que el tamaño también protege al clúster.
 */
export const PUBLISH_MAX_FILES = 50;
export const PUBLISH_MAX_TOTAL_BYTES = 256 * 1024;

const PublishPreviewSchema = z
  .object({
    files: z
      .record(
        z
          .string()
          .min(1)
          .max(200)
          .refine(
            (path) => !path.startsWith('/') && !path.split('/').includes('..'),
            {
              message: 'ruta insegura (absoluta o con "..")',
            },
          ),
        z.string(),
      )
      .refine((files) => Object.keys(files).length <= PUBLISH_MAX_FILES, {
        message: `máximo ${PUBLISH_MAX_FILES} archivos`,
      })
      .refine(
        (files) =>
          Object.entries(files).reduce(
            (sum, [path, text]) =>
              sum + Buffer.byteLength(path) + Buffer.byteLength(text),
            0,
          ) <= PUBLISH_MAX_TOTAL_BYTES,
        { message: `el proyecto supera ${PUBLISH_MAX_TOTAL_BYTES / 1024} KB` },
      ),
    /** "static": Jin sirve `index.html` con su propio servidor (sin npm). */
    template: z.enum(['static']).optional(),
    command: z.array(z.string().min(1)).min(1).optional(),
    port: z.number().int().positive().max(65535).optional(),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(24 * 60 * 60),
    slugHint: z.string().min(1).max(40).optional(),
  })
  .strict();
class PublishPreviewDto extends createZodDto(PublishPreviewSchema) {}

const PublishPreviewResultSchema = z.object({
  /** 'pending-approval': espera tu decisión. 'started': un modo de autonomía la dejó correr. */
  status: z.enum(['pending-approval', 'started']),
  requestId: z.string(),
  service: PreviewServiceSchema.optional(),
});
const PreviewFilesQuerySchema = z.object({
  /** Directorio del pod ("." = todo el espacio de trabajo). */
  dir: z
    .string()
    .min(1)
    .max(200)
    .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'))
    .default('.'),
});
class PreviewFilesQueryDto extends createZodDto(PreviewFilesQuerySchema) {}

const PreviewFilesSchema = z.object({
  files: z.record(z.string(), z.string()),
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
});
class PreviewFilesDto extends createZodDto(PreviewFilesSchema) {}

class PublishPreviewResultDto extends createZodDto(
  PublishPreviewResultSchema,
) {}

/**
 * Fase 6.2/6.3: mismo cliente (`ExecutorClientService`) que ya usa
 * `listPreviewServices`/`stopPreviewService` como tools del agent loop
 * (`executor-client.module.ts`) — acá solo se expone vía REST para el
 * panel "Preview apps" del dashboard, sin lógica nueva.
 */
@ApiTags('preview-services')
@Controller('api/preview-services')
export class PreviewServicesController {
  constructor(
    private readonly executorClientService: ExecutorClientService,
    private readonly ownerPublish: OwnerPreviewPublishService,
    private readonly auditService: AuditService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'El owner publica una app de preview sin pasar por el modelo (mismo HITL que la tool)',
  })
  @ZodResponse({ status: 200, type: PublishPreviewResultDto })
  async publish(
    @Body() body: PublishPreviewDto,
  ): Promise<z.infer<typeof PublishPreviewResultSchema>> {
    const result = await this.ownerPublish.publish(body);
    return result.status === 'started'
      ? {
          status: 'started',
          requestId: result.requestId,
          service: result.service,
        }
      : { status: 'pending-approval', requestId: result.requestId };
  }

  @Get(':serviceId/files')
  @ApiOperation({
    summary:
      'Archivos de texto de un pod vivo (sin node_modules, .git ni .jin), para traerlos al editor y editarlos',
  })
  @ZodResponse({ status: 200, type: PreviewFilesDto })
  async exportFiles(
    @Param('serviceId') serviceId: string,
    @Query() query: PreviewFilesQueryDto,
  ): Promise<z.infer<typeof PreviewFilesSchema>> {
    // Leer el contenido de un pod (código que escribió un agente) queda en el audit.
    await this.auditService.recordToolCall({
      requestId: randomUUID(),
      actor: 'owner:api',
      toolName: 'exportPreviewFiles',
      inputsHash: computeInputsHash({ serviceId, dir: query.dir }),
      planSummary: `Traer al editor los archivos del pod ${serviceId} (${query.dir})`,
      approvalStatus: 'auto',
    });
    const result = await this.executorClientService.exportPreviewFiles(
      serviceId,
      query.dir,
    );
    return { files: { ...result.files }, skipped: [...result.skipped] };
  }

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
      requestId?: string;
      db?: string;
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
