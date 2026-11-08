-- Baseline PostgreSQL Migration for Burrow
-- Squashed schema with full relational integrity, foreign keys, constraints, and triggers.

CREATE TYPE "public"."card_priority" AS ENUM('low', 'medium', 'high', 'urgent');
--> statement-breakpoint
CREATE TYPE "public"."invite_role" AS ENUM('editor', 'viewer');
--> statement-breakpoint
CREATE TYPE "public"."link_target_type" AS ENUM('user', 'notepad', 'card', 'board');
--> statement-breakpoint
CREATE TYPE "public"."notepad_kind" AS ENUM('notepad', 'card');
--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('mention', 'assigned');
--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('owner', 'editor', 'viewer');
--> statement-breakpoint

-- 1. Better Auth tables
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

CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");
--> statement-breakpoint

CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
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
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");
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

CREATE TABLE "bootstrap_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"claim_email" text,
	"user_id" text,
	"workspace_id" text,
	CONSTRAINT "bootstrap_singleton" CHECK (id = 1),
	CONSTRAINT "bootstrap_state_valid" CHECK (
		(status = 'empty' AND claim_email IS NULL AND user_id IS NULL AND workspace_id IS NULL)
		OR (status = 'claimed' AND claim_email IS NOT NULL AND user_id IS NULL AND workspace_id IS NULL)
		OR (status = 'complete' AND ((user_id IS NULL AND workspace_id IS NULL) OR (claim_email IS NOT NULL AND user_id IS NOT NULL AND workspace_id IS NOT NULL)))
	)
);
--> statement-breakpoint
INSERT INTO "bootstrap_state" ("id", "status") VALUES (1, 'empty') ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- 2. Workspaces, Members, Invites
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint

CREATE TABLE "members" (
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"role" "role" NOT NULL,
	"joined_at" bigint NOT NULL,
	CONSTRAINT "members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE INDEX "members_user" ON "members" USING btree ("user_id");
--> statement-breakpoint

CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"email" text NOT NULL,
	"role" "invite_role" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" text REFERENCES "user"("id") ON DELETE SET NULL,
	"expires_at" bigint NOT NULL,
	"accepted_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_hash_uq" ON "invites" USING btree ("token_hash");
--> statement-breakpoint

-- 3. Projects and Project Files
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"icon" text,
	"color" text,
	"position" text NOT NULL,
	"archived_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "projects_id_workspace_uq" UNIQUE("id", "workspace_id")
);
--> statement-breakpoint
CREATE INDEX "projects_ws" ON "projects" USING btree ("workspace_id","position");
--> statement-breakpoint

CREATE TABLE "project_files" (
	"project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"filename" text,
	"byte_size" integer,
	"created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "project_files_project_id_storage_key_pk" PRIMARY KEY("project_id","storage_key")
);
--> statement-breakpoint
CREATE INDEX "project_files_storage_key_idx" ON "project_files" USING btree ("storage_key");
--> statement-breakpoint

-- 4. Notepads
CREATE TABLE "notepads" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"parent_id" text REFERENCES "notepads"("id") ON DELETE CASCADE,
	"kind" "notepad_kind" DEFAULT 'notepad' NOT NULL,
	"title" text DEFAULT 'Untitled' NOT NULL,
	"icon" text,
	"cover_key" text,
	"content" text DEFAULT '[]' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"position" text NOT NULL,
	"is_favorite" boolean DEFAULT false NOT NULL,
	"deleted_at" bigint,
	"deletion_operation_id" text,
	"created_by" text REFERENCES "user"("id") ON DELETE SET NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"plain_text" text,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, title || ' ' || coalesce(plain_text, ''))) STORED,
	CONSTRAINT "notepads_id_kind_uq" UNIQUE("id", "kind"),
	CONSTRAINT "notepads_project_workspace_fk" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "notepads_tree" ON "notepads" USING btree ("project_id","parent_id","position");
--> statement-breakpoint
CREATE INDEX "notepads_deleted_idx" ON "notepads" USING btree ("project_id","deleted_at");
--> statement-breakpoint
CREATE INDEX "notepads_project_deleted_position_idx" ON "notepads" USING btree ("project_id","deleted_at","position");
--> statement-breakpoint
CREATE INDEX "notepads_deletion_operation_idx" ON "notepads" USING btree ("deletion_operation_id");
--> statement-breakpoint
CREATE INDEX "notepads_fts_idx" ON "notepads" USING gin ("search_vector");
--> statement-breakpoint

-- 5. Boards, Board Columns, Cards
CREATE TABLE "boards" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"icon" text,
	"position" text NOT NULL,
	"deleted_at" bigint,
	"deletion_operation_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "boards_project_workspace_fk" FOREIGN KEY ("project_id", "workspace_id") REFERENCES "projects"("id", "workspace_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "boards_project" ON "boards" USING btree ("project_id","position");
--> statement-breakpoint

CREATE TABLE "board_columns" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL REFERENCES "boards"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"color" text,
	"position" text NOT NULL,
	"wip_limit" integer,
	CONSTRAINT "board_columns_id_board_uq" UNIQUE("id", "board_id")
);
--> statement-breakpoint
CREATE INDEX "columns_board" ON "board_columns" USING btree ("board_id","position");
--> statement-breakpoint

CREATE TABLE "cards" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL REFERENCES "boards"("id") ON DELETE CASCADE,
	"column_id" text NOT NULL,
	"notepad_id" text NOT NULL REFERENCES "notepads"("id") ON DELETE CASCADE,
	"kind" "notepad_kind" DEFAULT 'card' NOT NULL CHECK (kind = 'card'),
	"position" text NOT NULL,
	"priority" "card_priority",
	"due_date" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "cards_notepad_id_unique" UNIQUE("notepad_id"),
	CONSTRAINT "cards_column_board_fk" FOREIGN KEY ("column_id", "board_id") REFERENCES "board_columns"("id", "board_id") ON DELETE CASCADE,
	CONSTRAINT "cards_notepad_kind_fk" FOREIGN KEY ("notepad_id", "kind") REFERENCES "notepads"("id", "kind") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "cards_column" ON "cards" USING btree ("column_id","position");
--> statement-breakpoint

CREATE TABLE "card_assignees" (
	"card_id" text NOT NULL REFERENCES "cards"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"assigned_at" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "card_assignees_card_id_user_id_pk" PRIMARY KEY("card_id","user_id")
);
--> statement-breakpoint

CREATE TABLE "card_subtasks" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL REFERENCES "cards"("id") ON DELETE CASCADE,
	"title" text NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"position" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "subtasks_card" ON "card_subtasks" USING btree ("card_id","position");
--> statement-breakpoint

CREATE TABLE "card_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"card_id" text NOT NULL REFERENCES "cards"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"content" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "comments_card" ON "card_comments" USING btree ("card_id","created_at");
--> statement-breakpoint

-- 6. Tags & Notepad Tags
CREATE TABLE "tags" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"color" text,
	CONSTRAINT "tags_project_name_uq" UNIQUE("project_id", "name")
);
--> statement-breakpoint

CREATE TABLE "notepad_tags" (
	"notepad_id" text NOT NULL REFERENCES "notepads"("id") ON DELETE CASCADE,
	"tag_id" text NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
	CONSTRAINT "notepad_tags_notepad_id_tag_id_pk" PRIMARY KEY("notepad_id","tag_id")
);
--> statement-breakpoint

-- 7. Notepad Links
CREATE TABLE "notepad_links" (
	"source_id" text NOT NULL REFERENCES "notepads"("id") ON DELETE CASCADE,
	"target_type" "link_target_type" NOT NULL,
	"target_id" text NOT NULL,
	CONSTRAINT "notepad_links_source_id_target_type_target_id_pk" PRIMARY KEY("source_id","target_type","target_id")
);
--> statement-breakpoint
CREATE INDEX "links_target" ON "notepad_links" USING btree ("target_type","target_id");
--> statement-breakpoint

-- 8. Notifications & Edit Locks
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"type" "notification_type" NOT NULL,
	"actor_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"notepad_id" text REFERENCES "notepads"("id") ON DELETE CASCADE,
	"card_id" text REFERENCES "cards"("id") ON DELETE CASCADE,
	"read_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notifications_user" ON "notifications" USING btree ("user_id","read_at","created_at");
--> statement-breakpoint

CREATE TABLE "edit_locks" (
	"notepad_id" text PRIMARY KEY NOT NULL REFERENCES "notepads"("id") ON DELETE CASCADE,
	"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"client_id" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint

-- 9. Scope Cascade Guards (Fail Closed)
CREATE OR REPLACE FUNCTION guard_project_scope_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM notepads n
    WHERE n.project_id = OLD.id AND n.workspace_id <> OLD.workspace_id
  ) OR EXISTS (
    SELECT 1 FROM notepads parent
    JOIN notepads child ON child.parent_id = parent.id
    WHERE parent.project_id = OLD.id
      AND (child.project_id <> parent.project_id OR child.workspace_id <> parent.workspace_id)
  ) OR EXISTS (
    SELECT 1 FROM boards b
    WHERE b.project_id = OLD.id AND b.workspace_id <> OLD.workspace_id
  ) OR EXISTS (
    SELECT 1
    FROM boards b
    JOIN cards c ON c.board_id = b.id
    LEFT JOIN projects p ON p.id = b.project_id
    LEFT JOIN board_columns col ON col.id = c.column_id
    LEFT JOIN notepads n ON n.id = c.notepad_id
    WHERE b.project_id = OLD.id
      AND (p.id IS NULL OR b.workspace_id <> p.workspace_id
        OR col.id IS NULL OR col.board_id <> c.board_id
        OR n.id IS NULL OR n.kind <> 'card'
        OR n.project_id <> p.id OR n.workspace_id <> p.workspace_id)
  ) OR EXISTS (
    SELECT 1 FROM cards c
    JOIN board_columns col ON col.id = c.column_id
    JOIN boards b ON b.id = col.board_id
    WHERE b.project_id = OLD.id AND c.board_id <> col.board_id
  ) THEN
    RAISE EXCEPTION 'scope_cascade_conflict' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS projects_scope_delete_guard ON projects;
CREATE TRIGGER projects_scope_delete_guard
BEFORE DELETE ON projects
FOR EACH ROW EXECUTE FUNCTION guard_project_scope_delete();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_notepad_scope_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM projects p WHERE p.id = OLD.project_id
  ) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = OLD.project_id AND p.workspace_id <> OLD.workspace_id
  ) OR EXISTS (
    SELECT 1 FROM notepads child
    WHERE child.parent_id = OLD.id
      AND (child.project_id <> OLD.project_id OR child.workspace_id <> OLD.workspace_id)
  ) OR EXISTS (
    SELECT 1
    FROM cards c
    LEFT JOIN boards b ON b.id = c.board_id
    LEFT JOIN projects p ON p.id = b.project_id
    LEFT JOIN board_columns col ON col.id = c.column_id
    WHERE c.notepad_id = OLD.id
      AND (OLD.kind <> 'card' OR b.id IS NULL
        OR col.id IS NULL OR col.board_id <> c.board_id
        OR b.workspace_id <> p.workspace_id
        OR OLD.project_id <> p.id OR OLD.workspace_id <> p.workspace_id)
  ) THEN
    RAISE EXCEPTION 'scope_cascade_conflict' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS notepads_scope_delete_guard ON notepads;
CREATE TRIGGER notepads_scope_delete_guard
BEFORE DELETE ON notepads
FOR EACH ROW EXECUTE FUNCTION guard_notepad_scope_delete();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_board_scope_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM projects p WHERE p.id = OLD.project_id
  ) THEN
    RETURN OLD;
  END IF;

  IF EXISTS (
    SELECT 1 FROM projects p
    WHERE p.id = OLD.project_id AND p.workspace_id <> OLD.workspace_id
  ) OR EXISTS (
    SELECT 1
    FROM cards c
    LEFT JOIN board_columns col ON col.id = c.column_id
    LEFT JOIN notepads n ON n.id = c.notepad_id
    LEFT JOIN projects p ON p.id = OLD.project_id
    WHERE c.board_id = OLD.id
      AND (col.id IS NULL OR col.board_id <> c.board_id
        OR n.id IS NULL OR n.kind <> 'card'
        OR OLD.workspace_id <> p.workspace_id
        OR n.project_id <> p.id OR n.workspace_id <> p.workspace_id)
  ) OR EXISTS (
    SELECT 1 FROM cards c
    JOIN board_columns col ON col.id = c.column_id
    WHERE col.board_id = OLD.id AND c.board_id <> OLD.id
  ) THEN
    RAISE EXCEPTION 'scope_cascade_conflict' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS boards_scope_delete_guard ON boards;
CREATE TRIGGER boards_scope_delete_guard
BEFORE DELETE ON boards
FOR EACH ROW EXECUTE FUNCTION guard_board_scope_delete();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_board_column_scope_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cards c
    WHERE c.column_id = OLD.id AND c.board_id <> OLD.board_id
  ) THEN
    RAISE EXCEPTION 'scope_cascade_conflict' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS board_columns_scope_delete_guard ON board_columns;
CREATE TRIGGER board_columns_scope_delete_guard
BEFORE DELETE ON board_columns
FOR EACH ROW EXECUTE FUNCTION guard_board_column_scope_delete();
--> statement-breakpoint

-- 10. Scope Write Guards (Enforce scope invariants on write)
CREATE OR REPLACE FUNCTION enforce_scope_write() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'notepads' THEN
    IF NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = NEW.project_id AND p.workspace_id = NEW.workspace_id)
      OR (NEW.parent_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM notepads p WHERE p.id = NEW.parent_id
          AND p.project_id = NEW.project_id AND p.workspace_id = NEW.workspace_id
      )) OR EXISTS (
        SELECT 1 FROM notepads child WHERE child.parent_id = OLD.id
          AND (child.project_id <> NEW.project_id OR child.workspace_id <> NEW.workspace_id)
      ) OR EXISTS (
        SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
        JOIN projects p ON p.id = b.project_id WHERE c.notepad_id = OLD.id
          AND (NEW.kind <> 'card' OR NEW.project_id <> p.id OR NEW.workspace_id <> p.workspace_id)
      ) OR (NEW.kind = 'card' AND NEW.parent_id IS NOT NULL) THEN
      RAISE EXCEPTION 'scope_write_conflict' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'projects' THEN
    IF EXISTS (SELECT 1 FROM notepads n WHERE n.project_id = OLD.id AND n.workspace_id <> NEW.workspace_id)
      OR EXISTS (SELECT 1 FROM boards b WHERE b.project_id = OLD.id AND b.workspace_id <> NEW.workspace_id) THEN
      RAISE EXCEPTION 'scope_write_conflict' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'boards' THEN
    IF NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = NEW.project_id AND p.workspace_id = NEW.workspace_id)
      OR EXISTS (
        SELECT 1 FROM cards c LEFT JOIN board_columns col ON col.id = c.column_id
        LEFT JOIN notepads n ON n.id = c.notepad_id
        WHERE c.board_id = OLD.id AND (col.id IS NULL OR col.board_id <> OLD.id
          OR n.id IS NULL OR n.kind <> 'card'
          OR n.project_id <> NEW.project_id OR n.workspace_id <> NEW.workspace_id)
      ) THEN
      RAISE EXCEPTION 'scope_write_conflict' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'cards' THEN
    IF NOT EXISTS (
      SELECT 1 FROM boards b
      JOIN board_columns col ON col.id = NEW.column_id AND col.board_id = NEW.board_id
      JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
      JOIN notepads n ON n.id = NEW.notepad_id AND n.kind = 'card'
        AND n.project_id = p.id AND n.workspace_id = p.workspace_id
      WHERE b.id = NEW.board_id
    ) THEN
      RAISE EXCEPTION 'scope_write_conflict' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'notepad_tags' THEN
    IF NOT EXISTS (
      SELECT 1 FROM notepads n JOIN tags t ON t.id = NEW.tag_id
      WHERE n.id = NEW.notepad_id AND n.project_id = t.project_id
    ) THEN
      RAISE EXCEPTION 'scope_write_conflict' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'tags' THEN
    IF EXISTS (
      SELECT 1 FROM notepad_tags nt JOIN notepads n ON n.id = nt.notepad_id
      WHERE nt.tag_id = OLD.id AND n.project_id <> NEW.project_id
    ) THEN
      RAISE EXCEPTION 'scope_write_conflict' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'notepad_links' THEN
    IF NOT EXISTS (
      SELECT 1 FROM notepads source WHERE source.id = NEW.source_id AND (
        (NEW.target_type = 'notepad' AND EXISTS (
          SELECT 1 FROM notepads target WHERE target.id = NEW.target_id
            AND target.project_id = source.project_id AND target.workspace_id = source.workspace_id
        )) OR (NEW.target_type = 'card' AND EXISTS (
          SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
          JOIN projects p ON p.id = b.project_id JOIN notepads body ON body.id = c.notepad_id
          WHERE c.id = NEW.target_id AND p.id = source.project_id
            AND b.workspace_id = source.workspace_id AND body.kind = 'card'
            AND body.project_id = p.id AND body.workspace_id = p.workspace_id
        )) OR (NEW.target_type = 'board' AND EXISTS (
          SELECT 1 FROM boards b JOIN projects p ON p.id = b.project_id
          WHERE b.id = NEW.target_id AND p.id = source.project_id
            AND b.workspace_id = source.workspace_id
        )) OR (NEW.target_type = 'user' AND EXISTS (
          SELECT 1 FROM members m WHERE m.workspace_id = source.workspace_id
            AND m.user_id = NEW.target_id
        ))
      )
    ) THEN
      RAISE EXCEPTION 'scope_write_conflict' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'card_assignees' THEN
    IF NOT EXISTS (
      SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
      JOIN members m ON m.workspace_id = b.workspace_id AND m.user_id = NEW.user_id
      WHERE c.id = NEW.card_id
    ) THEN
      RAISE EXCEPTION 'scope_write_conflict' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'card_comments' THEN
    IF NOT EXISTS (
      SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
      JOIN members m ON m.workspace_id = b.workspace_id AND m.user_id = NEW.user_id
      WHERE c.id = NEW.card_id
    ) THEN
      RAISE EXCEPTION 'scope_write_conflict' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'notifications' THEN
    IF NOT EXISTS (
      SELECT 1 FROM members m WHERE m.workspace_id = NEW.workspace_id AND m.user_id = NEW.user_id
    ) OR (NEW.notepad_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM notepads n WHERE n.id = NEW.notepad_id AND n.workspace_id = NEW.workspace_id
    )) OR (NEW.card_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
      WHERE c.id = NEW.card_id AND b.workspace_id = NEW.workspace_id
    )) THEN
      RAISE EXCEPTION 'scope_write_conflict' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS notepads_scope_write_guard ON notepads;
CREATE TRIGGER notepads_scope_write_guard BEFORE INSERT OR UPDATE OF project_id, workspace_id, parent_id, kind ON notepads FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
DROP TRIGGER IF EXISTS projects_scope_write_guard ON projects;
CREATE TRIGGER projects_scope_write_guard BEFORE UPDATE OF workspace_id ON projects FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
DROP TRIGGER IF EXISTS boards_scope_write_guard ON boards;
CREATE TRIGGER boards_scope_write_guard BEFORE INSERT OR UPDATE OF project_id, workspace_id ON boards FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
DROP TRIGGER IF EXISTS cards_scope_write_guard ON cards;
CREATE TRIGGER cards_scope_write_guard BEFORE INSERT OR UPDATE OF board_id, column_id, notepad_id, kind ON cards FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
DROP TRIGGER IF EXISTS notepad_tags_scope_write_guard ON notepad_tags;
CREATE TRIGGER notepad_tags_scope_write_guard BEFORE INSERT OR UPDATE OF notepad_id, tag_id ON notepad_tags FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
DROP TRIGGER IF EXISTS tags_scope_write_guard ON tags;
CREATE TRIGGER tags_scope_write_guard BEFORE UPDATE OF project_id ON tags FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
DROP TRIGGER IF EXISTS notepad_links_scope_write_guard ON notepad_links;
CREATE TRIGGER notepad_links_scope_write_guard BEFORE INSERT OR UPDATE OF source_id, target_type, target_id ON notepad_links FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
DROP TRIGGER IF EXISTS card_assignees_scope_write_guard ON card_assignees;
CREATE TRIGGER card_assignees_scope_write_guard BEFORE INSERT OR UPDATE OF card_id, user_id ON card_assignees FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
DROP TRIGGER IF EXISTS card_comments_scope_write_guard ON card_comments;
CREATE TRIGGER card_comments_scope_write_guard BEFORE INSERT OR UPDATE OF card_id, user_id ON card_comments FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
DROP TRIGGER IF EXISTS notifications_scope_write_guard ON notifications;
CREATE TRIGGER notifications_scope_write_guard BEFORE INSERT OR UPDATE OF workspace_id, user_id, notepad_id, card_id ON notifications FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint

-- 11. Cleanup notepad_links targets on delete
CREATE OR REPLACE FUNCTION cleanup_notepad_links_target() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'notepads' THEN
    DELETE FROM notepad_links WHERE target_type = 'notepad' AND target_id = OLD.id;
  ELSIF TG_TABLE_NAME = 'cards' THEN
    DELETE FROM notepad_links WHERE target_type = 'card' AND target_id = OLD.id;
  ELSIF TG_TABLE_NAME = 'boards' THEN
    DELETE FROM notepad_links WHERE target_type = 'board' AND target_id = OLD.id;
  ELSIF TG_TABLE_NAME = 'user' THEN
    DELETE FROM notepad_links WHERE target_type = 'user' AND target_id = OLD.id;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS notepads_cleanup_links ON notepads;
CREATE TRIGGER notepads_cleanup_links AFTER DELETE ON notepads FOR EACH ROW EXECUTE FUNCTION cleanup_notepad_links_target();
--> statement-breakpoint
DROP TRIGGER IF EXISTS cards_cleanup_links ON cards;
CREATE TRIGGER cards_cleanup_links AFTER DELETE ON cards FOR EACH ROW EXECUTE FUNCTION cleanup_notepad_links_target();
--> statement-breakpoint
DROP TRIGGER IF EXISTS boards_cleanup_links ON boards;
CREATE TRIGGER boards_cleanup_links AFTER DELETE ON boards FOR EACH ROW EXECUTE FUNCTION cleanup_notepad_links_target();
--> statement-breakpoint
DROP TRIGGER IF EXISTS user_cleanup_links ON "user";
CREATE TRIGGER user_cleanup_links AFTER DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION cleanup_notepad_links_target();
--> statement-breakpoint

-- 12. Workspace Member Removal Cascades
CREATE OR REPLACE FUNCTION members_cleanup_workspace_assignments() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM card_assignees ca
  WHERE ca.user_id = OLD.user_id
    AND EXISTS (
      SELECT 1 FROM cards c
      JOIN board_columns col ON col.id = c.column_id
      JOIN boards b ON b.id = col.board_id
      WHERE c.id = ca.card_id AND b.workspace_id = OLD.workspace_id
    );

  DELETE FROM edit_locks el
  WHERE el.user_id = OLD.user_id
    AND EXISTS (
      SELECT 1 FROM notepads n
      WHERE n.id = el.notepad_id AND n.workspace_id = OLD.workspace_id
    );

  RETURN OLD;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS members_cleanup_workspace_assignments ON members;
CREATE TRIGGER members_cleanup_workspace_assignments
AFTER DELETE ON members
FOR EACH ROW EXECUTE FUNCTION members_cleanup_workspace_assignments();
--> statement-breakpoint

-- 10. User Deletion Guard (Prevents deleting sole owner)
CREATE OR REPLACE FUNCTION prevent_sole_owner_user_delete()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM members m1
    WHERE m1.user_id = OLD.id AND m1.role = 'owner'
    AND NOT EXISTS (
      SELECT 1 FROM members m2
      WHERE m2.workspace_id = m1.workspace_id
        AND m2.user_id <> OLD.id
        AND m2.role = 'owner'
    )
  ) THEN
    RAISE EXCEPTION 'cannot_delete_sole_owner: user % is the sole owner of one or more workspaces', OLD.id
      USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_prevent_sole_owner_user_delete ON "user";
CREATE TRIGGER trg_prevent_sole_owner_user_delete
  BEFORE DELETE ON "user"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_sole_owner_user_delete();

