import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { dateCodec } from '../common/dto/date-codec';
import { AuditService } from './audit.service';

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});
class ListQueryDto extends createZodDto(ListQuerySchema) {}

// `AuditLogRow.id` es `bigserial({ mode: 'bigint' })` (`db/schema.ts`) —
// un `bigint` real no es serializable por `JSON.stringify` nativo
// (Express reventaría con cualquier fila real, bug preexistente nunca
// detectado porque ningún test serializaba una fila real por HTTP).
// Se convierte a `string` en el controller, mismo criterio que ya usa
// `nextCursor`.
const AuditLogEntrySchema = z.object({
  id: z.string(),
  requestId: z.string(),
  // `dateCodec`, no `z.date()`: Zod v4 no representa `Date` en JSON
  // Schema; el codec documenta ISO string y usa `.encode()` sobre el
  // `Date` real de Drizzle al responder (ver `{ codec: true }` abajo).
  timestamp: dateCodec,
  actor: z.string(),
  actionType: z.string(),
  toolName: z.string().nullable(),
  inputsHash: z.string(),
  planSummary: z.string().nullable(),
  approvalStatus: z.string(),
  approver: z.string().nullable(),
  externalInputsSummary: z.string().nullable(),
  prevHash: z.string(),
  currentHash: z.string(),
});

const ListRecentResponseSchema = z.object({
  items: z.array(AuditLogEntrySchema),
  nextCursor: z.string().nullable(),
});
class ListRecentResponseDto extends createZodDto(ListRecentResponseSchema, {
  codec: true,
}) {}
type ListRecentResponse = z.infer<typeof ListRecentResponseSchema>;

@ApiTags('audit')
@Controller('api/audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get()
  @ApiOperation({ summary: 'Audit log paginado, más reciente primero' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ZodResponse({ status: 200, type: ListRecentResponseDto })
  async list(@Query() query: ListQueryDto): Promise<ListRecentResponse> {
    const result = await this.auditService.listRecent({
      limit: query.limit,
      cursor: query.cursor,
    });
    return {
      items: result.items.map((row) => ({ ...row, id: row.id.toString() })),
      nextCursor: result.nextCursor,
    };
  }
}
