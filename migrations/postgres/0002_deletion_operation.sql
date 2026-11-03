ALTER TABLE "boards" ADD COLUMN "deletion_operation_id" text;--> statement-breakpoint
ALTER TABLE "notepads" ADD COLUMN "deletion_operation_id" text;--> statement-breakpoint
CREATE INDEX "notepads_deletion_operation_idx" ON "notepads" USING btree ("deletion_operation_id");