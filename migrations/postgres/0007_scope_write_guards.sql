-- Enforce tenant relationships on inserts and scope-changing updates. Existing
-- corruption is reported by check:data; this migration never relocates rows.
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
    IF NEW.target_type IN ('notepad', 'card', 'board') AND NOT EXISTS (
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
CREATE TRIGGER notepads_scope_write_guard BEFORE INSERT OR UPDATE OF project_id, workspace_id, parent_id, kind ON notepads FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
CREATE TRIGGER projects_scope_write_guard BEFORE UPDATE OF workspace_id ON projects FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
CREATE TRIGGER boards_scope_write_guard BEFORE INSERT OR UPDATE OF project_id, workspace_id ON boards FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
CREATE TRIGGER cards_scope_write_guard BEFORE INSERT OR UPDATE OF board_id, column_id, notepad_id ON cards FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
CREATE TRIGGER notepad_tags_scope_write_guard BEFORE INSERT OR UPDATE OF notepad_id, tag_id ON notepad_tags FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
CREATE TRIGGER tags_scope_write_guard BEFORE UPDATE OF project_id ON tags FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
CREATE TRIGGER notepad_links_scope_write_guard BEFORE INSERT OR UPDATE OF source_id, target_type, target_id ON notepad_links FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
CREATE TRIGGER card_assignees_scope_write_guard BEFORE INSERT OR UPDATE OF card_id, user_id ON card_assignees FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
CREATE TRIGGER card_comments_scope_write_guard BEFORE INSERT OR UPDATE OF card_id, user_id ON card_comments FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
--> statement-breakpoint
CREATE TRIGGER notifications_scope_write_guard BEFORE INSERT OR UPDATE OF workspace_id, user_id, notepad_id, card_id ON notifications FOR EACH ROW EXECUTE FUNCTION enforce_scope_write();
