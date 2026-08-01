CREATE TABLE IF NOT EXISTS "agent_orchestration_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"objective" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"parent_session_id" text NOT NULL,
	"final_response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "agent_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"assigned_sub_agent_id" text,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_tickets_run_id_agent_orchestration_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_orchestration_runs"("id")
);

CREATE TABLE IF NOT EXISTS "agent_ticket_comments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_type" text NOT NULL,
	"author_id" text,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_ticket_comments_ticket_id_agent_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."agent_tickets"("id")
);

CREATE INDEX IF NOT EXISTS "agent_tickets_run_id_idx" ON "agent_tickets" ("run_id");
CREATE INDEX IF NOT EXISTS "agent_ticket_comments_ticket_id_idx" ON "agent_ticket_comments" ("ticket_id");
