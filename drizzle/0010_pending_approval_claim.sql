-- Issue #36 / ADR 0010: reclamo atómico de la ejecución de una aprobación.
-- Escrita a mano (como 0008/0009): la cadena de snapshots de drizzle-kit sigue
-- rota desde la 0003, deuda ya documentada y fuera de alcance de este PR.
ALTER TABLE "pending_approvals" ADD COLUMN IF NOT EXISTS "executing_at" timestamp with time zone;
ALTER TABLE "pending_approvals" ADD COLUMN IF NOT EXISTS "execution_error" text;
