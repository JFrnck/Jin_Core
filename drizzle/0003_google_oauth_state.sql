CREATE TABLE IF NOT EXISTS "google_oauth_token_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
