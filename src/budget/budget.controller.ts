import { randomUUID } from 'node:crypto';
import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto, ZodResponse } from 'nestjs-zod';
import { z } from 'zod';
import { OkResultDto } from '../common/dto/ok-result.dto';
import { AuditService } from '../audit/audit.service';
import { BudgetService } from './budget.service';
import { KillSwitchService } from './kill-switch.service';

// Único lugar donde se declara el shape de `GET /api/budget` — de acá
// sale el tipo TS (`BudgetStatus`), la validación de `@ZodResponse` (si
// el servicio alguna vez devuelve un campo con el tipo/forma equivocada,
// falla ruidoso en vez de servir un contrato mentiroso) y el schema que
// termina en `contracts/openapi.json` para que Web/CLI generen tipos
// reales (regla de oro #11 — antes de esto, ningún endpoint de Fase 6.1
// tenía request/response documentado).
const BudgetStatusSchema = z.object({
  dailyUsageRatio: z.number(),
  dailyUsageUsd: z.number(),
  dailyUsageTokens: z.number(),
  dailyLimitUsd: z.number(),
  dailyLimitTokens: z.number(),
  killSwitchActive: z.boolean(),
  killSwitch: z.object({
    activatedAt: z.string().nullable(),
    reason: z.string().nullable(),
    currentHourTokens: z.number(),
    avgHourlyTokens: z.number(),
  }),
});

export class BudgetStatusDto extends createZodDto(BudgetStatusSchema) {}
export type BudgetStatus = z.infer<typeof BudgetStatusSchema>;

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
  @ZodResponse({ status: 200, type: BudgetStatusDto })
  async getStatus(): Promise<BudgetStatus> {
    const limits = this.budgetService.getLimits();
    const [dailyUsage, dailyUsageRatio, killSwitch] = await Promise.all([
      this.budgetService.getDailyUsage(),
      this.budgetService.getDailyUsageRatio(),
      this.killSwitchService.getStatus(),
    ]);
    return {
      dailyUsageRatio,
      dailyUsageUsd: dailyUsage.costUsd,
      dailyUsageTokens: dailyUsage.inputTokens + dailyUsage.outputTokens,
      dailyLimitUsd: limits.dailyMaxUsd,
      dailyLimitTokens: limits.dailyMaxTokens,
      killSwitchActive: killSwitch.active,
      killSwitch: {
        activatedAt: killSwitch.activatedAt,
        reason: killSwitch.reason,
        currentHourTokens: killSwitch.currentHourTokens,
        avgHourlyTokens: killSwitch.avgHourlyTokens,
      },
    };
  }

  @Post('unpause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Desactiva el kill switch manualmente — mismo flujo que /unpause en Telegram',
  })
  @ZodResponse({ status: 200, type: OkResultDto })
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
