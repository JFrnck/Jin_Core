import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { MemoryService } from './memory.service';
import {
  MEMORY_ENTRY_TYPES,
  type MemoryEntry,
  type RecallFilters,
} from './memory.types';

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
type RecallBody = z.infer<typeof RecallBodySchema>;

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
  async recall(
    @Body(new ZodValidationPipe(RecallBodySchema)) body: RecallBody,
  ): Promise<readonly MemoryEntry[]> {
    return this.memoryService.recall(
      body.query,
      body.k,
      buildRecallFilters(body.filters),
    );
  }
}
