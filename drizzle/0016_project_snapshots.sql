-- 2026-10-05 (ADR 0021): respaldos de proyectos del editor del iPhone. Escrita a mano (como
-- 0008-0015; la cadena de snapshots de drizzle-kit sigue rota). Código + configuración + NOMBRES de
-- variables; nunca valores (viven en el Llavero del iPhone).
CREATE TABLE IF NOT EXISTS "project_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" integer NOT NULL,
	"files" jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "project_snapshots_file_count_check" CHECK ("file_count" >= 0 AND "file_count" <= 50),
	CONSTRAINT "project_snapshots_total_bytes_check" CHECK ("total_bytes" >= 0 AND "total_bytes" <= 262144)
);
CREATE INDEX IF NOT EXISTS "project_snapshots_created_at_idx" ON "project_snapshots" ("created_at" DESC);
