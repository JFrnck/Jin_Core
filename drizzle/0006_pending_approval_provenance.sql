ALTER TABLE "pending_approvals" ADD COLUMN IF NOT EXISTS "actor" text;
ALTER TABLE "pending_approvals" ADD COLUMN IF NOT EXISTS "external_inputs_summary" text;
