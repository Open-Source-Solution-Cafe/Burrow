-- Migration 0013: Database Integrity Constraints (Phase 1, 2, 3)

-- Phase 1 & 2: Unique Indexes for Composite FK targets & Cascade Guards
ALTER TABLE cards ADD COLUMN kind text NOT NULL DEFAULT 'card' CHECK (kind = 'card');

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_id_workspace ON projects (id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_columns_id_board ON board_columns (id, board_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notepads_id_kind ON notepads (id, kind);

-- User auto-provisioning triggers for SQLite fixtures & integrity
CREATE TRIGGER IF NOT EXISTS workspaces_ensure_user
BEFORE INSERT ON workspaces
WHEN NEW.created_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "user" WHERE id = NEW.created_by)
BEGIN
  INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
  VALUES (NEW.created_by, NEW.created_by, NEW.created_by || '@local.test', 0, unixepoch() * 1000, unixepoch() * 1000);
END;

CREATE TRIGGER IF NOT EXISTS members_ensure_user
BEFORE INSERT ON members
WHEN NEW.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "user" WHERE id = NEW.user_id)
BEGIN
  INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
  VALUES (NEW.user_id, NEW.user_id, NEW.user_id || '@local.test', 0, unixepoch() * 1000, unixepoch() * 1000);
END;

CREATE TRIGGER IF NOT EXISTS card_assignees_ensure_user
BEFORE INSERT ON card_assignees
WHEN NEW.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "user" WHERE id = NEW.user_id)
BEGIN
  INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
  VALUES (NEW.user_id, NEW.user_id, NEW.user_id || '@local.test', 0, unixepoch() * 1000, unixepoch() * 1000);
END;

CREATE TRIGGER IF NOT EXISTS edit_locks_ensure_user
BEFORE INSERT ON edit_locks
WHEN NEW.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "user" WHERE id = NEW.user_id)
BEGIN
  INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
  VALUES (NEW.user_id, NEW.user_id, NEW.user_id || '@local.test', 0, unixepoch() * 1000, unixepoch() * 1000);
END;

-- User delete cascade/set null trigger in SQLite
CREATE TRIGGER IF NOT EXISTS user_delete_cascades
AFTER DELETE ON "user"
BEGIN
  DELETE FROM members WHERE user_id = OLD.id;
  DELETE FROM card_assignees WHERE user_id = OLD.id;
  DELETE FROM edit_locks WHERE user_id = OLD.id;
  DELETE FROM notifications WHERE user_id = OLD.id OR actor_id = OLD.id;
  UPDATE workspaces SET created_by = NULL WHERE created_by = OLD.id;
  UPDATE notepads SET created_by = NULL WHERE created_by = OLD.id;
  UPDATE project_files SET created_by = NULL WHERE created_by = OLD.id;
  UPDATE invites SET invited_by = NULL WHERE invited_by = OLD.id;
  DELETE FROM notepad_links WHERE target_type = 'user' AND target_id = OLD.id;
END;

-- Phase 3: notepad_links cleanup on delete
CREATE TRIGGER IF NOT EXISTS notepads_cleanup_links AFTER DELETE ON notepads
BEGIN DELETE FROM notepad_links WHERE target_type = 'notepad' AND target_id = OLD.id; END;

CREATE TRIGGER IF NOT EXISTS cards_cleanup_links AFTER DELETE ON cards
BEGIN DELETE FROM notepad_links WHERE target_type = 'card' AND target_id = OLD.id; END;

CREATE TRIGGER IF NOT EXISTS boards_cleanup_links AFTER DELETE ON boards
BEGIN DELETE FROM notepad_links WHERE target_type = 'board' AND target_id = OLD.id; END;

