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
  vector,
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
  // Mismos nombres/semántica que `audit_log.actor`/`external_inputs_summary`
  // (AGENTS.md 5.1 punto 3) — acá viven ANTES de la resolución, para que el
  // owner los vea al decidir, no solo después en el audit log. Nullable:
  // el path de `orchestrator.service.ts` no tiene historial de mensajes de
  // LLM del que extraer inputs externos (no es un turno de agente).
  actor: text('actor'),
  externalInputsSummary: text('external_inputs_summary'),
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
  // Reclamo atómico de la ejecución (issue #36, ADR 0010). Se setea con
  // `UPDATE ... WHERE executing_at IS NULL RETURNING` -- solo UNA llamada
  // gana, así que la acción irreversible corre a lo sumo una vez aunque
  // lleguen N aprobaciones simultáneas (Web + Telegram, doble clic). Éxito
  // -> la fila se borra. Fallo -> `executing_at` vuelve a NULL y el motivo
  // queda en `execution_error`: NO hay reintento automático, exige una nueva
  // aprobación humana (regla de oro #9). Un reclamo que nunca se libera
  // (proceso muerto entre el claim y el final) no se reintenta jamás:
  // TimeoutService avisa y el owner decide.
  executingAt: timestamp('executing_at', { withTimezone: true }),
  executionError: text('execution_error'),
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
 * Fila singleton (`id` siempre 1) con el estado del lock del audit log
 * por corrupción de cadena (BLUEPRINT 9.5). Persistido a propósito —
 * antes vivía solo como `ChainVerificationService.locked` en memoria
 * (gap documentado en comentarios de `budget_kill_switch` de arriba, sin
 * resolver hasta ahora): un simple redeploy no debe reanudar escrituras
 * sobre una cadena que sigue corrupta, misma garantía que el kill switch.
 */
export const auditChainLock = pgTable('audit_chain_lock', {
  id: integer('id').primaryKey(),
  locked: boolean('locked').notNull().default(false),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  reason: text('reason'),
});

export type AuditChainLockRow = typeof auditChainLock.$inferSelect;
export type NewAuditChainLockRow = typeof auditChainLock.$inferInsert;

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

/**
 * Un objetivo multi-agente descompuesto (Fase 5.4, ADR 0005). Persistido
 * para que un run pueda quedar días bloqueado esperando HITL y sobrevivir
 * restarts — mismo criterio que `pendingApprovals`. `status`: 'running' |
 * 'blocked' | 'done' | 'failed' | 'killed'.
 */
export const agentOrchestrationRuns = pgTable('agent_orchestration_runs', {
  id: uuid('id').primaryKey(),
  objective: text('objective').notNull(),
  status: text('status').notNull().default('running'),
  parentSessionId: text('parent_session_id').notNull(),
  finalResponse: text('final_response'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export type AgentOrchestrationRunRow =
  typeof agentOrchestrationRuns.$inferSelect;
export type NewAgentOrchestrationRunRow =
  typeof agentOrchestrationRuns.$inferInsert;

/**
 * Un ticket del task ledger estilo Jira (Fase 5.4, ADR 0005). El board
 * que renderiza Fase 6. `status`: 'pending' | 'in-progress' | 'done' |
 * 'failed' | 'blocked'. `dependsOn`/`allowedTools` son arrays de
 * ids/nombres — sin tabla de join, nadie necesita consultarlos
 * relacionalmente hoy (mismo criterio que `transcript` en
 * `telegramSessions`: jsonb tipado en vez de normalizar de más).
 */
export const agentTickets = pgTable('agent_tickets', {
  id: uuid('id').primaryKey(),
  runId: uuid('run_id')
    .notNull()
    .references(() => agentOrchestrationRuns.id),
  description: text('description').notNull(),
  status: text('status').notNull().default('pending'),
  assignedSubAgentId: text('assigned_sub_agent_id'),
  allowedTools: jsonb('allowed_tools').$type<string[]>().notNull().default([]),
  dependsOn: jsonb('depends_on').$type<string[]>().notNull().default([]),
  result: text('result'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AgentTicketRow = typeof agentTickets.$inferSelect;
export type NewAgentTicketRow = typeof agentTickets.$inferInsert;

/**
 * Hilo de comentarios de un ticket (Fase 5.4, ADR 0005) — lo que hace un
 * conflicto entre sub-agentes VISIBLE en vez de suprimido. `authorType`:
 * 'orchestrator' | 'sub_agent' | 'owner'. `kind`: 'note' | 'result' |
 * 'conflict' | 'resolution'.
 */
export const agentTicketComments = pgTable('agent_ticket_comments', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  ticketId: uuid('ticket_id')
    .notNull()
    .references(() => agentTickets.id),
  authorType: text('author_type').notNull(),
  authorId: text('author_id'),
  kind: text('kind').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AgentTicketCommentRow = typeof agentTicketComments.$inferSelect;
export type NewAgentTicketCommentRow = typeof agentTicketComments.$inferInsert;

/**
 * Estado persistido de sesiones conversacionales de Telegram (Fase 5.3).
 * Persistido en Postgres para garantizar cero pérdida de datos ante restarts
 * de pods o rolling updates (BLUEPRINT 1.3). Guarda el transcript completo
 * de turnos de la sesión en curso.
 */
export const telegramSessions = pgTable('telegram_sessions', {
  id: uuid('id').primaryKey(),
  transcript: jsonb('transcript')
    .$type<Array<{ role: 'user' | 'assistant'; content: string }>>()
    .notNull()
    .default([]),
  status: text('status').notNull().default('active'),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TelegramSessionRow = typeof telegramSessions.$inferSelect;
export type NewTelegramSessionRow = typeof telegramSessions.$inferInsert;

/**
 * Corpus propio (Fase 9.3, BLUEPRINT §3.3/§3.3.1/§6.4) -- distinto de
 * `src/memory/` (sqlite-vec, memoria del agente): dos almacenes, dos
 * ciclos de vida, la frontera de §3.3.1 no se negocia. `content` YA
 * pasó por `sanitizeForIndexing()` (src/security/injection-sanitizer.ts,
 * AGENTS.md 5.1 punto 2) antes de llegar acá -- nunca texto crudo de una
 * fuente externa. Dedup real por `(source, sourceId)` -- ver la
 * constraint UNIQUE en la migración, no solo a nivel app.
 */
export const corpusEntries = pgTable('corpus_entries', {
  id: uuid('id').primaryKey(),
  // 'gmail' hoy (Fase 9.3) -- 'canvas_pdf'/'notes' quedan documentados
  // como extensión futura en el ADR, sin stub vacío acá.
  source: text('source').notNull(),
  // ID estable en la fuente (Gmail messageId) -- la clave real de dedup.
  sourceId: text('source_id').notNull(),
  content: text('content').notNull(),
  // Libre por fuente (ej. subject/from/date para gmail) -- sin schema
  // fijo porque cada fuente futura trae metadata distinta.
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CorpusEntryRow = typeof corpusEntries.$inferSelect;
export type NewCorpusEntryRow = typeof corpusEntries.$inferInsert;

/**
 * Tabla separada de `corpusEntries` a propósito -- es el JOIN relacional
 * real (`corpus_embeddings` × `corpus_entries`) el argumento entero de
 * BLUEPRINT §3.3 para elegir pgvector sobre Qdrant/Supabase ("un JOIN
 * entre tasks y task_embeddings es SQL nativo"). `vector()` es nativo de
 * drizzle-orm 0.45+ -- sin paquete `pgvector` externo.
 */
export const corpusEmbeddings = pgTable('corpus_embeddings', {
  id: uuid('id').primaryKey(),
  entryId: uuid('entry_id')
    .notNull()
    .references(() => corpusEntries.id),
  // Misma dimensión que EMBEDDING_DIMENSIONS en
  // src/memory/embedding-provider.ts -- no hay un solo lugar que las una
  // (ese módulo no sabe nada de Postgres), la dimensión real de cada
  // fila queda auditable vía `modeloEmbedding`.
  embedding: vector('embedding', { dimensions: 1024 }).notNull(),
  // EMBEDDING_MODEL_ID (embedding-provider.ts) -- reusa el mismo
  // EmbeddingProvider que src/memory/, nunca un segundo proveedor.
  modeloEmbedding: text('modelo_embedding').notNull(),
});

export type CorpusEmbeddingRow = typeof corpusEmbeddings.$inferSelect;
export type NewCorpusEmbeddingRow = typeof corpusEmbeddings.$inferInsert;

/**
 * Overrides de `hitlLevel` VIGENTES por tool (Fase 9.5, BLUEPRINT 12.3).
 * `classifyToolCall` (src/hitl/classifier.ts) sigue siendo la única
 * fuente del nivel ESTÁTICO -- esta tabla no lo toca. La resuelve un
 * paso separado (`FeatureFlagsService.resolveEffectiveLevel`) que
 * AgentService llama después de clasificar.
 *
 * Invariante de seguridad (por qué esta tabla nunca contiene un nivel
 * "sin aprobar" que baje protección): un override que SUBE el nivel se
 * escribe directo al recargar `config/feature-flags.yaml` (subir nunca
 * necesita aprobación humana adicional -- ya es más restrictivo que el
 * estático). Un override que BAJA el nivel nunca se escribe acá hasta
 * que exista una aprobación `dual-confirm` real, resuelta vía el mismo
 * mecanismo de `DualConfirmService`/`ApprovalExecutionService` que
 * cualquier otra tool `dual-confirm` (PR #8, Fase 4.2) -- sin tabla ni
 * flujo de aprobación nuevo. Mientras la aprobación esté pendiente, NO
 * hay fila acá para esa tool: `resolveEffectiveLevel` cae al nivel
 * estático (fail-safe, nunca al revés).
 */
export const featureFlagHitlOverrides = pgTable('feature_flag_hitl_overrides', {
  toolName: text('tool_name').primaryKey(),
  level: text('level').notNull(), // HitlLevel — ver src/hitl/types.ts
  approvedAt: timestamp('approved_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  approver: text('approver').notNull(),
});

export type FeatureFlagHitlOverrideRow =
  typeof featureFlagHitlOverrides.$inferSelect;
export type NewFeatureFlagHitlOverrideRow =
  typeof featureFlagHitlOverrides.$inferInsert;

/**
 * Modo de autonomía del HITL (ADR 0010). Fila singleton (`id` siempre 1),
 * sembrada por la migración 0011 en `supervised` -- el default seguro. Es
 * estado del OWNER: solo lo cambian los caminos autenticados (Telegram
 * `/mode`, `POST /api/autonomy`) o el ejecutor de una aprobación
 * `dual-confirm`; nunca una tool que el LLM pueda invocar.
 *
 * `expires_at`: todo modo distinto de `supervised` caduca solo y vuelve al
 * modo seguro (lectura perezosa + cron por minuto). `relaxed_count` /
 * `window_started_at`: contador del freno de emergencia -- si un modo
 * relajado autoejecuta demasiadas acciones por hora, revierte solo.
 */
export const autonomyModeState = pgTable('autonomy_mode_state', {
  id: integer('id').primaryKey(),
  mode: text('mode').notNull().default('supervised'), // AutonomyMode -- ver src/autonomy/autonomy.types.ts
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  setBy: text('set_by').notNull().default('system:default'),
  approvalRequestId: uuid('approval_request_id'),
  changedAt: timestamp('changed_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  relaxedCount: integer('relaxed_count').notNull().default(0),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AutonomyModeStateRow = typeof autonomyModeState.$inferSelect;
