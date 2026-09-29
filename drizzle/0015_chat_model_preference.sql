-- 2026-09-28: preferencia de modelo del owner para chat_conversational
-- (vendor/modelo/esfuerzo elegidos a mano en la app, en vez del `primary`
-- fijo de config/models.yaml). Escrita a mano (como 0008-0011; la cadena
-- de snapshots de drizzle-kit sigue rota).
CREATE TABLE IF NOT EXISTS "chat_model_preference" (
	"id" integer PRIMARY KEY NOT NULL,
	"vendor" text,
	"model_id" text,
	"effort" text,
	"set_by" text DEFAULT 'system:default' NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_model_preference_vendor_check" CHECK ("vendor" IN ('anthropic', 'google', 'openai') OR "vendor" IS NULL),
	CONSTRAINT "chat_model_preference_effort_check" CHECK ("effort" IN ('low', 'medium', 'high') OR "effort" IS NULL),
	CONSTRAINT "chat_model_preference_singleton_check" CHECK ("id" = 1)
);
-- Fila singleton sembrada SIN preferencia: el default siempre es el
-- `primary` de config/models.yaml hasta que el owner elija algo.
INSERT INTO "chat_model_preference" ("id") VALUES (1) ON CONFLICT DO NOTHING;
