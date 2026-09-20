-- Fase 9.4: persistir cada corrida del Shadowing Académico (00:00) para que la
-- alerta de las 06:00 pueda resumirla sin otra llamada a LLM, y para que una
-- corrida FALLIDA quede registrada (si no, las 06:00 no sabrían que falló).
-- Escrita a mano (como 0008-0011; la cadena de snapshots de drizzle-kit sigue rota).
CREATE TABLE IF NOT EXISTS "shadowing_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"summary_markdown" text,
	"courses_checked" integer DEFAULT 0 NOT NULL,
	"announcements_count" integer DEFAULT 0 NOT NULL,
	"assignments_count" integer DEFAULT 0 NOT NULL,
	"model_id" text,
	CONSTRAINT "shadowing_runs_status_check" CHECK ("status" IN ('ok', 'failed'))
);
CREATE INDEX IF NOT EXISTS "shadowing_runs_ran_at_idx" ON "shadowing_runs" ("ran_at" DESC);
