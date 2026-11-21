ALTER TABLE "public_shares" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;
