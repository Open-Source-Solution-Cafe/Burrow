-- Keep known cross-scope corruption from widening FK delete cascades. These
-- guards fail closed; they never repair or relocate legacy rows.
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
CREATE TRIGGER projects_scope_delete_guard
BEFORE DELETE ON projects
FOR EACH ROW EXECUTE FUNCTION guard_project_scope_delete();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_notepad_scope_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER notepads_scope_delete_guard
BEFORE DELETE ON notepads
FOR EACH ROW EXECUTE FUNCTION guard_notepad_scope_delete();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION guard_board_scope_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER board_columns_scope_delete_guard
BEFORE DELETE ON board_columns
FOR EACH ROW EXECUTE FUNCTION guard_board_column_scope_delete();
