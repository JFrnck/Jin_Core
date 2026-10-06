import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { OkResultDto } from '../common/dto/ok-result.dto';
import type { ProjectSnapshotRow } from '../db/schema';
import { CreateSnapshotSchema } from './project-snapshot.logic';
import { ProjectSnapshotsService } from './project-snapshots.service';
import type { ProjectSnapshotSummaryRow } from './project-snapshots.store';

class CreateSnapshotDto extends createZodDto(CreateSnapshotSchema) {}

const SnapshotSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
  fileCount: z.number(),
  totalBytes: z.number(),
  config: z.record(z.string(), z.unknown()),
});
class SnapshotSummaryDto extends createZodDto(SnapshotSummarySchema) {}

const SnapshotListSchema = z.object({
  snapshots: z.array(SnapshotSummarySchema),
});
class SnapshotListDto extends createZodDto(SnapshotListSchema) {}

const SnapshotDetailSchema = SnapshotSummarySchema.extend({
  files: z.record(z.string(), z.string()),
});
class SnapshotDetailDto extends createZodDto(SnapshotDetailSchema) {}

const toSummary = (
  row: ProjectSnapshotSummaryRow,
): z.infer<typeof SnapshotSummarySchema> => ({
  id: row.id,
  name: row.name,
  note: row.note,
  createdAt: row.createdAt.toISOString(),
  fileCount: row.fileCount,
  totalBytes: row.totalBytes,
  config: row.config,
});

/**
 * Respaldos de proyectos del editor del iPhone (ADR 0021): ver, restaurar y borrar. Lleva código,
 * configuración y NOMBRES de variables; nunca valores ni archivos que parezcan secretos.
 */
@ApiTags('project-snapshots')
@Controller('api/project-snapshots')
export class ProjectSnapshotsController {
  constructor(private readonly service: ProjectSnapshotsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Respaldar un proyecto del editor' })
  @ZodResponse({ status: 200, type: SnapshotSummaryDto })
  async create(
    @Body() body: CreateSnapshotDto,
  ): Promise<z.infer<typeof SnapshotSummarySchema>> {
    return toSummary(await this.service.create(body));
  }

  @Get()
  @ApiOperation({
    summary: 'Lista de respaldos (sin el contenido de los archivos)',
  })
  @ZodResponse({ status: 200, type: SnapshotListDto })
  async list(): Promise<z.infer<typeof SnapshotListSchema>> {
    return { snapshots: (await this.service.list()).map(toSummary) };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Un respaldo con sus archivos, para restaurarlo en el editor',
  })
  @ZodResponse({ status: 200, type: SnapshotDetailDto })
  async get(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<z.infer<typeof SnapshotDetailSchema>> {
    const row: ProjectSnapshotRow = await this.service.get(id);
    return { ...toSummary(row), files: row.files };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Borrar un respaldo' })
  @ZodResponse({ status: 200, type: OkResultDto })
  async remove(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ ok: true }> {
    await this.service.delete(id);
    return { ok: true };
  }
}
