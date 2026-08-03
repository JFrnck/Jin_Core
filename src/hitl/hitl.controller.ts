import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { PendingApprovalRow } from '../db/schema';
import {
  ApprovalExecutionService,
  type ResolveAndExecuteResult,
} from './approval-execution.service';
import { DualConfirmService } from './dual-confirm.service';

// Sistema single-user (BLUEPRINT 5.2) — mismo valor hardcodeado que ya
// usa `TelegramBotService.processApproval/processRejection`.
const APPROVER = 'owner';

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
  async listPending(): Promise<readonly PendingApprovalRow[]> {
    return this.dualConfirmService.listPending();
  }

  @Post(':requestId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Aprueba una acción pendiente — ejecuta la tool real igual que /approve en Telegram',
  })
  async approve(
    @Param('requestId') requestId: string,
  ): Promise<ResolveAndExecuteResult> {
    return this.approvalExecutionService.resolveAndExecute(requestId, APPROVER);
  }

  @Post(':requestId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rechaza una acción pendiente' })
  async reject(@Param('requestId') requestId: string): Promise<{ ok: true }> {
    await this.approvalExecutionService.resolveRejection(requestId, APPROVER);
    return { ok: true };
  }
}
