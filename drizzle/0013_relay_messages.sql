-- Puente Claude Code ↔ owner (ADR 0012): mensajes entre una sesión de Claude
-- Code corriendo en la VM y el owner, por un bot de Telegram SEPARADO del de
-- Jin. Escrita a mano (como 0008-0012; la cadena de snapshots de drizzle-kit
-- sigue rota).
--
-- Esta tabla es el registro del puente y NO toca `audit_log`: esa cadena está
-- hash-encadenada y es para acciones HITL, no para mensajería.
CREATE TABLE IF NOT EXISTS "relay_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- 'out' = Claude → owner. 'in' = owner → Claude.
	"direction" text NOT NULL,
	"body" text NOT NULL,
	-- Opciones ofrecidas en una pregunta ('out'); NULL en un mensaje simple.
	"options" jsonb,
	-- En un 'in' que responde a una pregunta: el id del 'out' que la hizo.
	-- Sin FK real a propósito: borrar una pregunta vieja no debe fallar por
	-- una respuesta huérfana, y la correlación la resuelve la app.
	"answer_to" uuid,
	-- message_id de Telegram del 'out', para poder editarlo al responderse.
	"telegram_message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Cuándo Claude leyó este 'in' (NULL = pendiente). Solo aplica a 'in'.
	"consumed_at" timestamp with time zone,
	CONSTRAINT "relay_messages_direction_check" CHECK ("direction" IN ('out', 'in'))
);

-- El inbox pregunta siempre por lo mismo: 'in' sin consumir, más viejo primero.
CREATE INDEX IF NOT EXISTS "relay_messages_pending_in_idx"
	ON "relay_messages" ("created_at")
	WHERE "direction" = 'in' AND "consumed_at" IS NULL;

-- Correlación pregunta → respuesta (modo `--wait` del CLI).
CREATE INDEX IF NOT EXISTS "relay_messages_answer_to_idx"
	ON "relay_messages" ("answer_to")
	WHERE "answer_to" IS NOT NULL;

-- Ventana del rate limit: cuántos 'out' en la última hora.
CREATE INDEX IF NOT EXISTS "relay_messages_out_created_idx"
	ON "relay_messages" ("created_at")
	WHERE "direction" = 'out';
