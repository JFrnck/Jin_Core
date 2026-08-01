CREATE TABLE IF NOT EXISTS "telegram_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
