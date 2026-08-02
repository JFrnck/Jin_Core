import { randomUUID } from 'node:crypto';
import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditService } from '../audit/audit.service';
import { BudgetService } from './budget.service';
import { KillSwitchService } from './kill-switch.service';

export interface BudgetStatus {
  readonly dailyUsageRatio: number;
  readonly killSwitchActive: boolean;
}

// Sistema single-user (BLUEPRINT 5.2) — mismo valor hardcodeado que ya
// usa el comando /unpause de Telegram.
const UNPAUSE_APPROVER = 'owner';

@ApiTags('budget')
@Controller('api/budget')
export class BudgetController {
  constructor(
    private readonly budgetService: BudgetService,
    private readonly killSwitchService: KillSwitchService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Estado actual de presupuesto diario y kill switch',
  })
  async getStatus(): Promise<BudgetStatus> {
    const [dailyUsageRatio, killSwitchActive] = await Promise.all([
      this.budgetService.getDailyUsageRatio(),
      this.killSwitchService.isActive(),
    ]);
    return { dailyUsageRatio, killSwitchActive };
  }

  @Post('unpause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Desactiva el kill switch manualmente — mismo flujo que /unpause en Telegram',
  })
  async unpause(): Promise<{ ok: true }> {
    await this.killSwitchService.unpause();
    await this.auditService.recordApproval({
      requestId: randomUUID(),
      approver: UNPAUSE_APPROVER,
      toolName: 'unpause',
      inputsHash: 'n/a',
    });
    return { ok: true };
  }
}
