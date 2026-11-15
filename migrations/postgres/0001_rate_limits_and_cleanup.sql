-- Persistent atomic rate limiting buckets and durable pending storage deletion records.
CREATE TABLE IF NOT EXISTS "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"reset_at" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "rate_limits_reset_at_idx" ON "rate_limits" ("reset_at");

CREATE TABLE IF NOT EXISTS "pending_storage_deletions" (
	"id" text PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"project_id" text,
	"workspace_id" text,
	"reason" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"next_retry_at" bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS "pending_storage_deletions_retry_idx" ON "pending_storage_deletions" ("next_retry_at", "created_at");
CREATE INDEX IF NOT EXISTS "pending_storage_deletions_key_idx" ON "pending_storage_deletions" ("storage_key");
