CREATE TABLE "project_files" (
	"project_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "project_files_project_id_storage_key_pk" PRIMARY KEY("project_id","storage_key")
);
--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_files_storage_key_idx" ON "project_files" USING btree ("storage_key");