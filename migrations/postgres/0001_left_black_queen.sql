CREATE TABLE "bootstrap_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"claim_email" text,
	"user_id" text,
	"workspace_id" text,
	CONSTRAINT "bootstrap_singleton" CHECK ("bootstrap_state"."id" = 1),
	CONSTRAINT "bootstrap_state_valid" CHECK (("bootstrap_state"."status" = 'empty' AND "bootstrap_state"."claim_email" IS NULL AND "bootstrap_state"."user_id" IS NULL AND "bootstrap_state"."workspace_id" IS NULL)
        OR ("bootstrap_state"."status" = 'claimed' AND "bootstrap_state"."claim_email" IS NOT NULL AND "bootstrap_state"."user_id" IS NULL AND "bootstrap_state"."workspace_id" IS NULL)
        OR ("bootstrap_state"."status" = 'complete' AND (("bootstrap_state"."user_id" IS NULL AND "bootstrap_state"."workspace_id" IS NULL) OR ("bootstrap_state"."claim_email" IS NOT NULL AND "bootstrap_state"."user_id" IS NOT NULL AND "bootstrap_state"."workspace_id" IS NOT NULL))))
);
--> statement-breakpoint
-- An account without a workspace requires operator recovery, not automatic adoption.
INSERT INTO "bootstrap_state" ("id", "status")
SELECT 1, CASE
  WHEN EXISTS (SELECT 1 FROM "workspaces") THEN 'complete'
  WHEN EXISTS (SELECT 1 FROM "user") THEN 'orphaned_accounts'
  ELSE 'empty'
END;
