CREATE TABLE IF NOT EXISTS "audit_chain_lock" (
	"id" integer PRIMARY KEY NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"locked_at" timestamp with time zone,
	"reason" text
);
