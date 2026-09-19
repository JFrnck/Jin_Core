CREATE TABLE IF NOT EXISTS "feature_flag_hitl_overrides" (
	"tool_name" text PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approver" text NOT NULL
);
