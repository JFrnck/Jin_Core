import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuditService, type ListRecentResult } from './audit.service';

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});
type ListQuery = z.infer<typeof ListQuerySchema>;

@ApiTags('audit')
@Controller('api/audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Audit log paginado, más reciente primero' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  async list(
    @Query(new ZodValidationPipe(ListQuerySchema)) query: ListQuery,
  ): Promise<ListRecentResult> {
    return this.auditService.listRecent({
      limit: query.limit,
      cursor: query.cursor,
    });
  }
}
