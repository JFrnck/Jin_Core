import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { BudgetService } from './budget.service';
import { KillSwitchService } from './kill-switch.service';

// Mismos umbrales que `TelegramBotService.checkDailyBudgetAlert()` (Fase 4.1).
const DAILY_ALERT_THRESHOLDS = [0.8, 1] as const;

export const BUDGET_THRESHOLD_CROSSED_EVENT = 'budget.threshold.crossed';
export const KILL_SWITCH_ACTIVATED_EVENT = 'budget.kill-switch.activated';

export interface BudgetThresholdCrossedEvent {
  readonly ratio: number;
  readonly threshold: number;
}

export interface KillSwitchActivatedEvent {
  readonly reason: string | null;
  readonly activatedAt: Date | null;
}

/**
 * Un solo sondeo del presupuesto y del kill switch (cada 5 min) que emite
 * eventos de dominio. Antes lo repetían `RealtimeGateway` y `TelegramBotService`;
 * con las notificaciones push (ADR 0014) iban a ser tres consumidores, el
 * umbral de AGENTS.md 1.1 para extraer. Telegram sigue con su propio sondeo
 * por ahora (su deduplicación es distinta y no entra en este cambio).
 *
 * "Polling disfrazado de push" (ADR 0007 #5): el kill switch no emite nada al
 * activarse, así que se detecta el flanco inactivo → activo.
 */
@Injectable()
export class BudgetAlertMonitor {
  private readonly logger = new Logger(BudgetAlertMonitor.name);
  private readonly notifiedThresholdsToday = new Set<number>();
  private lastResetDate = '';
  private lastKillSwitchActive = false;

  constructor(
    private readonly budgetService: BudgetService,
    private readonly killSwitchService: KillSwitchService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Cron('*/5 * * * *')
  async check(): Promise<void> {
    try {
      await this.checkKillSwitch();
      await this.checkDailyThresholds();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Error chequeando alertas de budget/kill-switch: ${message}`,
      );
    }
  }

  private async checkKillSwitch(): Promise<void> {
    const status = await this.killSwitchService.getStatus();
    if (status.active && !this.lastKillSwitchActive) {
      const event: KillSwitchActivatedEvent = {
        reason: status.reason,
        activatedAt: status.activatedAt ? new Date(status.activatedAt) : null,
      };
      this.eventEmitter.emit(KILL_SWITCH_ACTIVATED_EVENT, event);
    }
    this.lastKillSwitchActive = status.active;
  }

  private async checkDailyThresholds(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.notifiedThresholdsToday.clear();
      this.lastResetDate = today;
    }

    const ratio = await this.budgetService.getDailyUsageRatio();
    for (const threshold of DAILY_ALERT_THRESHOLDS) {
      if (ratio >= threshold && !this.notifiedThresholdsToday.has(threshold)) {
        this.notifiedThresholdsToday.add(threshold);
        const event: BudgetThresholdCrossedEvent = { ratio, threshold };
        this.eventEmitter.emit(BUDGET_THRESHOLD_CROSSED_EVENT, event);
      }
    }
  }
}
