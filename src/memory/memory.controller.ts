import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import {
  MEMORY_ENTRY_TYPES,
  MemoryEntryTypeSchema,
  type MemoryEntry,
  type RecallFilters,
} from './memory.types';
import { MemoryService } from './memory.service';

const RecallBodySchema = z.object({
  query: z.string().min(1),
  k: z.number().int().positive().max(50).default(5),
  filters: z
    .object({
      tipo: z.enum(MEMORY_ENTRY_TYPES).optional(),
      fuente: z.string().optional(),
      sessionId: z.string().optional(),
    })
    .optional(),
});
class RecallDto extends createZodDto(RecallBodySchema) {}
type RecallBody = z.infer<typeof RecallBodySchema>;

const MemoryEntrySchema = z.object({
  id: z.number(),
  content: z.string(),
  tipo: MemoryEntryTypeSchema,
  fuente: z.string(),
  fecha: z.string(),
  modeloEmbedding: z.string(),
  sessionId: z.string().optional(),
  distance: z.number().optional(),
});
class MemoryEntryDto extends createZodDto(MemoryEntrySchema) {}

// `exactOptionalPropertyTypes` prohíbe pasar `{ tipo: undefined }` donde
// el target declara `tipo?: X` (mismo criterio que `google.module.ts`) —
// se arma el objeto incluyendo solo las claves realmente presentes.
function buildRecallFilters(
  filters: RecallBody['filters'],
): RecallFilters | undefined {
  if (!filters) return undefined;
  return {
    ...(filters.tipo !== undefined ? { tipo: filters.tipo } : {}),
    ...(filters.fuente !== undefined ? { fuente: filters.fuente } : {}),
    ...(filters.sessionId !== undefined
      ? { sessionId: filters.sessionId }
      : {}),
  };
}

@ApiTags('memory')
@Controller('api/memory')
export class MemoryController {
  constructor(private readonly memoryService: MemoryService) {}

  @Post('recall')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recall de memoria extendida por similaridad semántica',
  })
  @ZodResponse({ status: 200, type: [MemoryEntryDto] })
  async recall(@Body() body: RecallDto): Promise<MemoryEntry[]> {
    return [
      ...(await this.memoryService.recall(
        body.query,
        body.k,
        buildRecallFilters(body.filters),
      )),
    ];
  }
}
