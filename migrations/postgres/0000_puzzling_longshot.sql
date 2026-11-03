CREATE TYPE "public"."card_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."invite_role" AS ENUM('editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."link_target_type" AS ENUM('user', 'notepad', 'card', 'board');--> statement-breakpoint
CREATE TYPE "public"."notepad_kind" AS ENUM('notepad', 'card');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('mention', 'assigned');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp (3) with time zone,
	"refresh_token_expires_at" timestamp (3) with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "board_columns" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text,
	"position" text NOT NULL,
	"wip_limit" integer
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"position" text NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_assignees" (
	"card_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "card_assignees_card_id_user_id_pk" PRIMARY KEY("card_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "card_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"user_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_subtasks" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL,
	"title" text NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"position" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"column_id" text NOT NULL,
	"notepad_id" text NOT NULL,
	"position" text NOT NULL,
	"priority" "card_priority",
	"due_date" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "cards_notepad_id_unique" UNIQUE("notepad_id")
);
--> statement-breakpoint
CREATE TABLE "edit_locks" (
	"notepad_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"role" "invite_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"accepted_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "members" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "role" NOT NULL,
	"joined_at" bigint NOT NULL,
	CONSTRAINT "members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "notepad_links" (
	"source_id" text NOT NULL,
	"target_type" "link_target_type" NOT NULL,
	"target_id" text NOT NULL,
	CONSTRAINT "notepad_links_source_id_target_type_target_id_pk" PRIMARY KEY("source_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "notepad_tags" (
	"notepad_id" text NOT NULL,
	"tag_id" text NOT NULL,
	CONSTRAINT "notepad_tags_notepad_id_tag_id_pk" PRIMARY KEY("notepad_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "notepads" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL,
	"parent_id" text,
	"kind" "notepad_kind" DEFAULT 'notepad' NOT NULL,
	"title" text DEFAULT 'Untitled' NOT NULL,
	"icon" text,
	"cover_key" text,
	"content" text DEFAULT '[]' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"position" text NOT NULL,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"plain_text" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, title || ' ' || coalesce(plain_text, ''))) STORED
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"type" "notification_type" NOT NULL,
	"actor_id" text NOT NULL,
	"notepad_id" text,
	"card_id" text,
	"read_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"color" text,
	"position" text NOT NULL,
	"archived_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_columns" ADD CONSTRAINT "board_columns_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_assignees" ADD CONSTRAINT "card_assignees_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_comments" ADD CONSTRAINT "card_comments_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_comments" ADD CONSTRAINT "card_comments_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_subtasks" ADD CONSTRAINT "card_subtasks_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_column_id_board_columns_id_fk" FOREIGN KEY ("column_id") REFERENCES "public"."board_columns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_notepad_id_notepads_id_fk" FOREIGN KEY ("notepad_id") REFERENCES "public"."notepads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edit_locks" ADD CONSTRAINT "edit_locks_notepad_id_notepads_id_fk" FOREIGN KEY ("notepad_id") REFERENCES "public"."notepads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notepad_links" ADD CONSTRAINT "notepad_links_source_id_notepads_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."notepads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notepad_tags" ADD CONSTRAINT "notepad_tags_notepad_id_notepads_id_fk" FOREIGN KEY ("notepad_id") REFERENCES "public"."notepads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notepad_tags" ADD CONSTRAINT "notepad_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notepads" ADD CONSTRAINT "notepads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notepads" ADD CONSTRAINT "notepads_parent_id_notepads_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."notepads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_notepad_id_notepads_id_fk" FOREIGN KEY ("notepad_id") REFERENCES "public"."notepads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "columns_board" ON "board_columns" USING btree ("board_id","position");--> statement-breakpoint
CREATE INDEX "boards_project" ON "boards" USING btree ("project_id","position");--> statement-breakpoint
CREATE INDEX "comments_card" ON "card_comments" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE INDEX "subtasks_card" ON "card_subtasks" USING btree ("card_id","position");--> statement-breakpoint
CREATE INDEX "cards_column" ON "cards" USING btree ("column_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_hash_uq" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "links_target" ON "notepad_links" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "notepads_tree" ON "notepads" USING btree ("project_id","parent_id","position");--> statement-breakpoint
CREATE INDEX "notepads_deleted_idx" ON "notepads" USING btree ("project_id","deleted_at");--> statement-breakpoint
CREATE INDEX "notepads_project_deleted_position_idx" ON "notepads" USING btree ("project_id","deleted_at","position");--> statement-breakpoint
CREATE INDEX "notepads_fts_idx" ON "notepads" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "notifications_user" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "projects_ws" ON "projects" USING btree ("workspace_id","position");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_project_name_uq" ON "tags" USING btree ("project_id","name");