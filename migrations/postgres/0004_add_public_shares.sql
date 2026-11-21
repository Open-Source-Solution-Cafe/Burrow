CREATE TABLE IF NOT EXISTS "public_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint,
	CONSTRAINT "public_shares_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "public_shares" ADD CONSTRAINT "public_shares_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_shares" ADD CONSTRAINT "public_shares_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_shares" ADD CONSTRAINT "public_shares_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "public_shares_token_uq" ON "public_shares" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "public_shares_target_uq" ON "public_shares" USING btree ("project_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "public_shares_ws_idx" ON "public_shares" USING btree ("workspace_id");
