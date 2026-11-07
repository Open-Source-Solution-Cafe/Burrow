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

CREATE OR REPLACE FUNCTION ensure_user_stub() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_uid text;
BEGIN
  IF TG_TABLE_NAME = 'workspaces' THEN v_uid := NEW.created_by;
  ELSIF TG_TABLE_NAME = 'members' THEN v_uid := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'invites' THEN v_uid := NEW.invited_by;
  ELSIF TG_TABLE_NAME = 'project_files' THEN v_uid := NEW.created_by;
  ELSIF TG_TABLE_NAME = 'notepads' THEN v_uid := NEW.created_by;
  ELSIF TG_TABLE_NAME = 'card_assignees' THEN v_uid := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'edit_locks' THEN v_uid := NEW.user_id;
  ELSIF TG_TABLE_NAME = 'notifications' THEN
    IF NEW.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "user" WHERE id = NEW.user_id) THEN
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (NEW.user_id, NEW.user_id, NEW.user_id || '@local.test', false, now(), now())
      ON CONFLICT (id) DO NOTHING;
    END IF;
    IF NEW.actor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "user" WHERE id = NEW.actor_id) THEN
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES (NEW.actor_id, NEW.actor_id, NEW.actor_id || '@local.test', false, now(), now())
      ON CONFLICT (id) DO NOTHING;
    END IF;
    RETURN NEW;
  END IF;

  IF v_uid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "user" WHERE id = v_uid) THEN
    INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (v_uid, v_uid, v_uid || '@local.test', false, now(), now())
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspaces_ensure_user_stub ON workspaces;
CREATE TRIGGER workspaces_ensure_user_stub BEFORE INSERT ON workspaces FOR EACH ROW EXECUTE FUNCTION ensure_user_stub();

DROP TRIGGER IF EXISTS members_ensure_user_stub ON members;
CREATE TRIGGER members_ensure_user_stub BEFORE INSERT ON members FOR EACH ROW EXECUTE FUNCTION ensure_user_stub();

DROP TRIGGER IF EXISTS invites_ensure_user_stub ON invites;
CREATE TRIGGER invites_ensure_user_stub BEFORE INSERT ON invites FOR EACH ROW EXECUTE FUNCTION ensure_user_stub();

DROP TRIGGER IF EXISTS project_files_ensure_user_stub ON project_files;
CREATE TRIGGER project_files_ensure_user_stub BEFORE INSERT ON project_files FOR EACH ROW EXECUTE FUNCTION ensure_user_stub();

DROP TRIGGER IF EXISTS notepads_ensure_user_stub ON notepads;
CREATE TRIGGER notepads_ensure_user_stub BEFORE INSERT ON notepads FOR EACH ROW EXECUTE FUNCTION ensure_user_stub();

DROP TRIGGER IF EXISTS card_assignees_ensure_user_stub ON card_assignees;
CREATE TRIGGER card_assignees_ensure_user_stub BEFORE INSERT ON card_assignees FOR EACH ROW EXECUTE FUNCTION ensure_user_stub();

DROP TRIGGER IF EXISTS edit_locks_ensure_user_stub ON edit_locks;
CREATE TRIGGER edit_locks_ensure_user_stub BEFORE INSERT ON edit_locks FOR EACH ROW EXECUTE FUNCTION ensure_user_stub();

DROP TRIGGER IF EXISTS notifications_ensure_user_stub ON notifications;
CREATE TRIGGER notifications_ensure_user_stub BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION ensure_user_stub();

-- Phase 2: Cross-Scope Workspace Drift Prevention via Composite Keys
ALTER TABLE projects ADD CONSTRAINT projects_id_workspace_uq UNIQUE (id, workspace_id);

ALTER TABLE notepads ADD CONSTRAINT notepads_project_workspace_fk FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE notepads ADD CONSTRAINT notepads_id_kind_uq UNIQUE (id, kind);

ALTER TABLE boards ADD CONSTRAINT boards_project_workspace_fk FOREIGN KEY (project_id, workspace_id) REFERENCES projects(id, workspace_id) ON DELETE CASCADE NOT VALID;

ALTER TABLE board_columns ADD CONSTRAINT board_columns_id_board_uq UNIQUE (id, board_id);

ALTER TABLE cards ADD COLUMN IF NOT EXISTS kind notepad_kind NOT NULL DEFAULT 'card' CHECK (kind = 'card');
ALTER TABLE cards ADD CONSTRAINT cards_column_board_fk FOREIGN KEY (column_id, board_id) REFERENCES board_columns(id, board_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE cards ADD CONSTRAINT cards_notepad_kind_fk FOREIGN KEY (notepad_id, kind) REFERENCES notepads(id, kind) ON DELETE CASCADE NOT VALID;

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