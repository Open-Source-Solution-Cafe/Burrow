ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "feature_flags" text DEFAULT '{}' NOT NULL;
