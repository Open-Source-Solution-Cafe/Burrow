-- Migration 0013: Database Integrity Constraints (Phase 1, 2, 3)

-- Phase 1 & 2: Unique Indexes for Composite FK targets & Cascade Guards
ALTER TABLE cards ADD COLUMN kind text NOT NULL DEFAULT 'card' CHECK (kind = 'card');

DROP TRIGGER IF EXISTS cards_scope_update_guard;
CREATE TRIGGER cards_scope_update_guard
BEFORE UPDATE OF board_id, column_id, notepad_id, kind ON cards
WHEN NOT EXISTS (
  SELECT 1 FROM boards b
  JOIN board_columns col ON col.id = NEW.column_id AND col.board_id = NEW.board_id
  JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
  JOIN notepads n ON n.id = NEW.notepad_id AND n.kind = 'card'
    AND n.project_id = p.id AND n.workspace_id = p.workspace_id
  WHERE b.id = NEW.board_id
)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_id_workspace ON projects (id, workspace_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_columns_id_board ON board_columns (id, board_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notepads_id_kind ON notepads (id, kind);

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

-- Phase 4: Member removal cleans up card assignments and locks in the workspace
CREATE TRIGGER IF NOT EXISTS members_cleanup_workspace_assignments
AFTER DELETE ON members
BEGIN
  DELETE FROM card_assignees
  WHERE user_id = OLD.user_id
    AND card_id IN (
      SELECT c.id FROM cards c
      JOIN board_columns col ON col.id = c.column_id
      JOIN boards b ON b.id = col.board_id
      WHERE b.workspace_id = OLD.workspace_id
    );

  DELETE FROM edit_locks
  WHERE user_id = OLD.user_id
    AND notepad_id IN (
      SELECT n.id FROM notepads n WHERE n.workspace_id = OLD.workspace_id
    );
END;

