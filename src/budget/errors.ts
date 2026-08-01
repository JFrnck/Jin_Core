import { JinError } from '../common/errors/jin-error';

/**
 * La llamada estimada excedería el presupuesto de la sesión actual
 * (BLUEPRINT 9.6 — "al 100%, detención, requiere continuación
 * explícita"). No hay downgrade posible a nivel de sesión: es un corte
 * duro, a diferencia del daily que primero degrada a modelos baratos.
 */
export class SessionBudgetExceededError extends JinError {
  constructor(sessionId: string) {
    super(`La sesión "${sessionId}" alcanzó su presupuesto máximo de tokens.`, {
      code: 'BUDGET_SESSION_EXCEEDED',
      httpStatus: 429,
    });
  }
}

/**
 * El presupuesto diario (tokens o $) llegó al 100% (BLUEPRINT 9.6 —
 * "solo tools auto con modelos Haiku/Flash hasta reset"). Se lanza
 * cuando ni siquiera esa degradación alcanza — ej. la llamada ya usa el
 * modelo más barato del profile y aun así no entra en lo que resta.
 */
export class DailyBudgetExceededError extends JinError {
  constructor() {
    super(
      'El presupuesto diario (tokens o USD) se agotó. Reset a las 00:00 hora local.',
      { code: 'BUDGET_DAILY_EXCEEDED', httpStatus: 429 },
    );
  }
}

/**
 * Kill switch activo (BLUEPRINT 9.6 — runaway detectado). Bloquea
 * absolutamente todas las llamadas al ModelProvider hasta un `/unpause`
 * resuelto con aprobación humana (`confirm` HITL) — nunca se levanta
 * solo, ni por reintento, ni por restart del pod (persistido en
 * `budget_kill_switch`).
 */
export class KillSwitchActiveError extends JinError {
  constructor(reason: string) {
    super(
      `Kill switch activo: ${reason}. Requiere /unpause con aprobación humana.`,
      { code: 'BUDGET_KILL_SWITCH_ACTIVE', httpStatus: 503 },
    );
  }
}
