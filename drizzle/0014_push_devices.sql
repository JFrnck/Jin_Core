-- Notificaciones push de la app iOS (ADR 0014). Escrita a mano (como
-- 0008-0013; la cadena de snapshots de drizzle-kit sigue rota).
--
-- Nada de esto toca `audit_log`: push solo avisa, nunca decide.

-- Un iPhone registrado por la app (token de APNs para notificaciones).
CREATE TABLE IF NOT EXISTS "push_devices" (
	"token" text PRIMARY KEY NOT NULL,
	-- 'sandbox' (build de Xcode) o 'production' (TestFlight/App Store): el
	-- token solo vale en el entorno de APNs que lo emitió.
	"environment" text NOT NULL,
	-- { "approval_new": true, ... } — los toggles de Ajustes de la app.
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_devices_environment_check" CHECK ("environment" IN ('sandbox', 'production'))
);

-- Tokens de Live Activities: uno por actividad en curso ('update', con la
-- referencia que muestra: requestId, runId, 'kill'...) o el token para
-- iniciarlas desde el servidor ('start', uno por dispositivo).
CREATE TABLE IF NOT EXISTS "push_activity_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"purpose" text NOT NULL,
	-- Solo en 'update': tipo de actividad y a qué se refiere.
	"kind" text,
	"reference_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_activity_tokens_environment_check" CHECK ("environment" IN ('sandbox', 'production')),
	CONSTRAINT "push_activity_tokens_purpose_check" CHECK ("purpose" IN ('update', 'start'))
);

-- "¿Hay una actividad viva para este run / esta aprobación?"
CREATE INDEX IF NOT EXISTS "push_activity_tokens_reference_idx"
	ON "push_activity_tokens" ("reference_id")
	WHERE "purpose" = 'update';
