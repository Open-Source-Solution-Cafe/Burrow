-- Migration 0009: Database Integrity Constraints (Phase 1, 2, 3)

-- Phase 1: Missing User Foreign Keys & Nullable Authorship
ALTER TABLE workspaces ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_created_by_fk FOREIGN KEY (created_by) REFERENCES "user"(id) ON DELETE SET NULL;

ALTER TABLE members ADD CONSTRAINT members_user_id_fk FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;

ALTER TABLE invites ALTER COLUMN invited_by DROP NOT NULL;
ALTER TABLE invites ADD CONSTRAINT invites_invited_by_fk FOREIGN KEY (invited_by) REFERENCES "user"(id) ON DELETE SET NULL;

ALTER TABLE project_files ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE project_files ADD CONSTRAINT project_files_created_by_fk FOREIGN KEY (created_by) REFERENCES "user"(id) ON DELETE SET NULL;

ALTER TABLE notepads ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE notepads ADD CONSTRAINT notepads_created_by_fk FOREIGN KEY (created_by) REFERENCES "user"(id) ON DELETE SET NULL;

ALTER TABLE card_assignees ADD CONSTRAINT card_assignees_user_id_fk FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;

ALTER TABLE edit_locks ADD CONSTRAINT edit_locks_user_id_fk FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;

ALTER TABLE notifications ADD CONSTRAINT notifications_user_id_fk FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD CONSTRAINT notifications_actor_id_fk FOREIGN KEY (actor_id) REFERENCES "user"(id) ON DELETE CASCADE;

-- Phase 2: Cross-Scope Workspace Drift Prevention via Composite Keys
ALTER TABLE projects ADD CONSTRAINT projects_id_workspace_uq UNIQUE (id, workspace_id);

ALTER TABLE notepads ADD CONSTRAINT notepads_project_workspace_fk FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE notepads ADD CONSTRAINT notepads_id_kind_uq UNIQUE (id, kind);

ALTER TABLE boards ADD CONSTRAINT boards_project_workspace_fk FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE NOT VALID;

ALTER TABLE board_columns ADD CONSTRAINT board_columns_id_board_uq UNIQUE (id, board_id);

ALTER TABLE cards ADD COLUMN IF NOT EXISTS kind notepad_kind NOT NULL DEFAULT 'card' CHECK (kind = 'card');
ALTER TABLE cards ADD CONSTRAINT cards_column_board_fk FOREIGN KEY (column_id, board_id) REFERENCES board_columns(id, board_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE cards ADD CONSTRAINT cards_notepad_kind_fk FOREIGN KEY (notepad_id, kind) REFERENCES notepads(id, kind) ON DELETE CASCADE NOT VALID;

DROP TRIGGER IF EXISTS cards_scope_write_guard ON cards;
CREATE TRIGGER cards_scope_write_guard BEFORE INSERT OR UPDATE OF board_id, column_id, notepad_id, kind ON cards FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();

-- Phase 3: notepad_links Orphans Cleanup on Delete
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

DROP TRIGGER IF EXISTS notepads_cleanup_links ON notepads;
CREATE TRIGGER notepads_cleanup_links AFTER DELETE ON notepads FOR EACH ROW EXECUTE FUNCTION cleanup_notepad_links_target();

DROP TRIGGER IF EXISTS cards_cleanup_links ON cards;
CREATE TRIGGER cards_cleanup_links AFTER DELETE ON cards FOR EACH ROW EXECUTE FUNCTION cleanup_notepad_links_target();

DROP TRIGGER IF EXISTS boards_cleanup_links ON boards;
CREATE TRIGGER boards_cleanup_links AFTER DELETE ON boards FOR EACH ROW EXECUTE FUNCTION cleanup_notepad_links_target();

DROP TRIGGER IF EXISTS user_cleanup_links ON "user";
CREATE TRIGGER user_cleanup_links AFTER DELETE ON "user" FOR EACH ROW EXECUTE FUNCTION cleanup_notepad_links_target();

-- Phase 4: Member Removal Cascades to Workspace Card Assignments & Locks
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

DROP TRIGGER IF EXISTS members_cleanup_workspace_assignments_trg ON members;
CREATE TRIGGER members_cleanup_workspace_assignments_trg
  AFTER DELETE ON members
  FOR EACH ROW
  EXECUTE FUNCTION members_cleanup_workspace_assignments();