-- ADR 0010: modos de autonomía del HITL (supervised | semi-auto | auto).
-- Escrita a mano (como 0008-0010; la cadena de snapshots de drizzle-kit sigue rota).
CREATE TABLE IF NOT EXISTS "autonomy_mode_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'supervised' NOT NULL,
	"expires_at" timestamp with time zone,
	"set_by" text DEFAULT 'system:default' NOT NULL,
	"approval_request_id" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"relaxed_count" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autonomy_mode_state_mode_check" CHECK ("mode" IN ('supervised', 'semi-auto', 'auto')),
	CONSTRAINT "autonomy_mode_state_singleton_check" CHECK ("id" = 1)
);
-- Fila singleton sembrada en el modo SEGURO: el default siempre es HITL completo.
INSERT INTO "autonomy_mode_state" ("id") VALUES (1) ON CONFLICT DO NOTHING;
