import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import type { PendingApprovalRow } from '../db/schema';
import { dateCodec, nullableDateCodec } from '../common/dto/date-codec';
import { OkResultDto } from '../common/dto/ok-result.dto';
import {
  ApprovalExecutionService,
  type ResolveAndExecuteResult,
} from './approval-execution.service';
import { DualConfirmService } from './dual-confirm.service';

// Sistema single-user (BLUEPRINT 5.2) — mismo valor hardcodeado que ya
// usa `TelegramBotService.processApproval/processRejection`.
const APPROVER = 'owner';

// Shape real de `pendingApprovals` (`src/db/schema.ts`) — `payload` es
// `jsonb` sin `.$type<T>()` (cada tool tiene el suyo, deliberadamente sin
// unificar), así que quedar en `unknown` es preciso, no un placeholder.
// Los campos `timestamp` llegan como `Date` real en este punto del
// pipeline (drizzle los deserializa así) — de ahí `dateCodec`/
// `nullableDateCodec` en vez de `z.date()` a secas (Zod v4 no puede
// representar `z.date()` en JSON Schema; el codec documenta el lado
// string ISO y usa `.encode()` sobre el `Date` real al responder, ver
// `{ codec: true }` abajo).
const PendingApprovalSchema = z.object({
  requestId: z.string(),
  toolName: z.string(),
  // Semánticamente 'confirm' | 'dual-confirm', pero la columna real es
  // `text()` sin constraint (`db/schema.ts`) — `z.string()` refleja el
  // tipo real en vez de narrowear algo que la DB no garantiza.
  level: z.string(),
  inputsHash: z.string(),
  planSummary: z.string().nullable(),
  payload: z.unknown(),
  // Mismos campos que `audit_log` (AGENTS.md 5.1 punto 3), disponibles acá
  // ya al crear la pending approval — ver plan de esta fase.
  actor: z.string().nullable(),
  externalInputsSummary: z.string().nullable(),
  createdAt: dateCodec,
  firstApprovedAt: nullableDateCodec,
  firstApprover: z.string().nullable(),
  availableAt: nullableDateCodec,
  escalatedAt: nullableDateCodec,
  // Issue #36: si la ejecución falló tras aprobar, el pendiente sigue vivo y
  // acá está el motivo -- el owner tiene que VER que la acción NO ocurrió y
  // que necesita aprobarla de nuevo. `executingAt` no nulo = en ejecución
  // ahora mismo (o trabada, si es de hace >15 min).
  executingAt: nullableDateCodec,
  executionError: z.string().nullable(),
});
class PendingApprovalDto extends createZodDto(PendingApprovalSchema, {
  codec: true,
}) {}

const ResolveAndExecuteResultSchema = z
  .discriminatedUnion('outcome', [
    z.object({ outcome: z.literal('awaiting-second') }),
    z.object({
      outcome: z.literal('resolved'),
      toolName: z.string(),
      result: z.unknown(),
    }),
  ])
  // Sin `.meta({id})`, nestjs-zod nombra el DTO anónimo (sin `class X
  // extends ...`, ver más abajo) "AugmentedZodDto" en el contrato — un
  // nombre inútil para quien genere tipos de Web/CLI desde ahí.
  .meta({ id: 'ResolveAndExecuteResult' });
// No es `class X extends createZodDto(...)`: un discriminated union no
// tiene un tipo de objeto único del que heredar (TS2509) — como DTO no
// se usa como anotación de tipo en ningún lado, basta el valor.
const ResolveAndExecuteResultDto = createZodDto(ResolveAndExecuteResultSchema);
// Swagger indexa los DTOs por el NOMBRE de la clase, y toda `createZodDto(...)`
// anónima se llama "AugmentedZodDto": dos DTOs de unión anónimos (este y
// `ChangeModeResultDto` de src/autonomy) colisionaban y `POST /api/hitl/{id}/approve`
// terminó documentando la respuesta de OTRO endpoint en el contrato. Un
// nombre propio por DTO lo evita (lo protege contracts/openapi.spec.ts).
Object.defineProperty(ResolveAndExecuteResultDto, 'name', {
  value: 'ResolveAndExecuteResultDto',
});

@ApiTags('hitl')
@Controller('api/hitl')
export class HitlController {
  constructor(
    private readonly dualConfirmService: DualConfirmService,
    private readonly approvalExecutionService: ApprovalExecutionService,
  ) {}

  @Get('pending')
  @ApiOperation({
    summary: 'Lista las aprobaciones pendientes (confirm/dual-confirm)',
  })
  @ZodResponse({ status: 200, type: [PendingApprovalDto] })
  async listPending(): Promise<PendingApprovalRow[]> {
    // Copia superficial: `@ZodResponse([...])` exige un array mutable en
    // la firma del método (TS2769 con `readonly T[]`) — el servicio
    // sigue devolviendo `readonly` hacia el resto del código.
    return [...(await this.dualConfirmService.listPending())];
  }

  @Post(':requestId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Aprueba una acción pendiente — ejecuta la tool real igual que /approve en Telegram',
  })
  @ZodResponse({ status: 200, type: ResolveAndExecuteResultDto })
  async approve(
    @Param('requestId') requestId: string,
  ): Promise<ResolveAndExecuteResult> {
    return this.approvalExecutionService.resolveAndExecute(requestId, APPROVER);
  }

  @Post(':requestId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rechaza una acción pendiente' })
  @ZodResponse({ status: 200, type: OkResultDto })
  async reject(@Param('requestId') requestId: string): Promise<{ ok: true }> {
    await this.approvalExecutionService.resolveRejection(requestId, APPROVER);
    return { ok: true };
  }
}
