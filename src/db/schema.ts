import {
  pgTable,
  bigserial,
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  uuid,
  timestamp,
  text,
} from 'drizzle-orm/pg-core';

/**
 * Log de auditoría inmutable (BLUEPRINT 9.5, ADR 0002). INSERT-ONLY:
 * ninguna fila se actualiza jamás — cada transición de estado de una
 * acción (pending → approved/rejected/timeout/abandoned) es una fila
 * NUEVA que comparte `requestId` con la fila que la originó. Modificar
 * una fila histórica invalida su hash y el de toda la cadena posterior
 * (AGENTS.md 5.6: "es un incidente de seguridad").
 */
export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  requestId: uuid('request_id').notNull(),
  timestamp: timestamp('timestamp', { withTimezone: true })
    .notNull()
    .defaultNow(),
  actor: text('actor').notNull(),
  actionType: text('action_type').notNull(),
  toolName: text('tool_name'),
  inputsHash: text('inputs_hash').notNull(),
  planSummary: text('plan_summary'),
  approvalStatus: text('approval_status').notNull(),
  approver: text('approver'),
  externalInputsSummary: text('external_inputs_summary'),
  prevHash: text('prev_hash').notNull(),
  currentHash: text('current_hash').notNull(),
});

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;

/**
 * Estado mutable de una aprobación en curso (ADR 0002). Vive aparte de
 * `audit_log` precisamente porque SÍ se actualiza mientras la aprobación
 * está pendiente (ej. registrar la primera confirmación de un
 * dual-confirm). Se borra al escribir la fila terminal en audit_log.
 * Persistida (no en memoria): sobrevive a un restart del pod de core.
 */
export const pendingApprovals = pgTable('pending_approvals', {
  requestId: uuid('request_id').primaryKey(),
  toolName: text('tool_name').notNull(),
  level: text('level').notNull(), // 'confirm' | 'dual-confirm'
  inputsHash: text('inputs_hash').notNull(),
  planSummary: text('plan_summary'),
  // Datos de la acción real a ejecutar si se aprueba (ej. to/subject/body
  // de un email) — sin esto no había dónde reconstruir "qué ejecutar" al
  // momento de aprobar (prerequisito de Fase 4.2, ver STATUS.md). Nullable:
  // acciones sin ejecución diferida (ej. /unpause) no necesitan payload.
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  firstApprovedAt: timestamp('first_approved_at', { withTimezone: true }),
  firstApprover: text('first_approver'),
  // Solo relevante para dual-confirm: la segunda aprobación no se acepta
  // antes de este instante (BLUEPRINT 9.2, ≥30s tras la primera).
  availableAt: timestamp('available_at', { withTimezone: true }),
  // Timestamp del primer aviso de escalamiento (BLUEPRINT 9.4, tools con
  // deadline: aviso a las 12h). Evita que timeout.service reenvíe el
  // mismo aviso en cada barrido mientras espera las 24h de abandono.
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
});

export type PendingApprovalRow = typeof pendingApprovals.$inferSelect;
export type NewPendingApprovalRow = typeof pendingApprovals.$inferInsert;

/**
 * Consumo acumulado por día local (BLUEPRINT 9.6 — límite diario de
 * tokens/$). Persistido (no en memoria): sobrevive a un restart del pod,
 * mismo criterio que `pendingApprovals` — a diferencia del acumulado de
 * sesión (efímero, en memoria en `src/budget/budget.service.ts`), perder
 * el conteo diario tras un restart resetearía el cap silenciosamente.
 */
export const budgetDailyUsage = pgTable('budget_daily_usage', {
  date: date('date', { mode: 'string' }).primaryKey(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: numeric('cost_usd', {
    mode: 'number',
    precision: 12,
    scale: 6,
  })
    .notNull()
    .default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type BudgetDailyUsageRow = typeof budgetDailyUsage.$inferSelect;
export type NewBudgetDailyUsageRow = typeof budgetDailyUsage.$inferInsert;

/**
 * Ventana rodante por hora (BLUEPRINT 9.6 — kill switch de runaway:
 * consumo de la hora actual vs. promedio de las últimas N horas).
 * Persistido por el mismo motivo que `budgetDailyUsage`.
 */
export const budgetHourlyUsage = pgTable('budget_hourly_usage', {
  hourBucket: timestamp('hour_bucket', { withTimezone: true }).primaryKey(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: numeric('cost_usd', {
    mode: 'number',
    precision: 12,
    scale: 6,
  })
    .notNull()
    .default(0),
});

export type BudgetHourlyUsageRow = typeof budgetHourlyUsage.$inferSelect;
export type NewBudgetHourlyUsageRow = typeof budgetHourlyUsage.$inferInsert;

/**
 * Fila singleton (`id` siempre 1) con el estado del kill switch
 * (BLUEPRINT 9.6). Persistido a propósito, a diferencia de
 * `ChainVerificationService.locked` (en memoria, gap preexistente ajeno
 * a esta tabla): un simple redeploy no debe "despausar" el sistema sin
 * intervención humana — esa es la garantía central del kill switch.
 */
export const budgetKillSwitch = pgTable('budget_kill_switch', {
  id: integer('id').primaryKey(),
  active: boolean('active').notNull().default(false),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  reason: text('reason'),
});

export type BudgetKillSwitchRow = typeof budgetKillSwitch.$inferSelect;
export type NewBudgetKillSwitchRow = typeof budgetKillSwitch.$inferInsert;

/**
 * Fila singleton (`id` siempre 1) con el estado de refresco del token
 * de Google OAuth Testing Mode (Fase 4.2). Persistido para calcular con
 * precisión el aviso 24h antes del vencimiento de 7 días, sobreviviendo
 * a restarts de pods.
 */
export const googleOAuthTokenState = pgTable('google_oauth_token_state', {
  id: integer('id').primaryKey(),
  lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type GoogleOAuthTokenStateRow =
  typeof googleOAuthTokenState.$inferSelect;
export type NewGoogleOAuthTokenStateRow =
  typeof googleOAuthTokenState.$inferInsert;
