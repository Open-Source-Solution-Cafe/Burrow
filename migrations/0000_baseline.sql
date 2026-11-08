-- Baseline SQLite / D1 Migration for Burrow
-- Squashed schema with full relational integrity, foreign keys, constraints, and triggers.

-- 1. Better Auth tables
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`emailVerified` integer DEFAULT false NOT NULL,
	`image` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);
--> statement-breakpoint

CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expiresAt` integer NOT NULL,
	`token` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`ipAddress` text,
	`userAgent` text,
	`userId` text NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);
--> statement-breakpoint
CREATE INDEX `session_user_idx` ON `session` (`userId`);
--> statement-breakpoint

CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`accountId` text NOT NULL,
	`providerId` text NOT NULL,
	`userId` text NOT NULL,
	`accessToken` text,
	`refreshToken` text,
	`idToken` text,
	`accessTokenExpiresAt` integer,
	`refreshTokenExpiresAt` integer,
	`scope` text,
	`password` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_idx` ON `account` (`userId`);
--> statement-breakpoint

CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint

CREATE TABLE `bootstrap_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`claim_email` text,
	`user_id` text,
	`workspace_id` text,
	CONSTRAINT "bootstrap_singleton" CHECK (`bootstrap_state`.`id` = 1),
	CONSTRAINT "bootstrap_state_valid" CHECK (
		(`bootstrap_state`.`status` = 'empty' AND `bootstrap_state`.`claim_email` IS NULL AND `bootstrap_state`.`user_id` IS NULL AND `bootstrap_state`.`workspace_id` IS NULL)
		OR (`bootstrap_state`.`status` = 'claimed' AND `bootstrap_state`.`claim_email` IS NOT NULL AND `bootstrap_state`.`user_id` IS NULL AND `bootstrap_state`.`workspace_id` IS NULL)
		OR (`bootstrap_state`.`status` = 'complete' AND ((`bootstrap_state`.`user_id` IS NULL AND `bootstrap_state`.`workspace_id` IS NULL) OR (`bootstrap_state`.`claim_email` IS NOT NULL AND `bootstrap_state`.`user_id` IS NOT NULL AND `bootstrap_state`.`workspace_id` IS NOT NULL)))
	)
);
--> statement-breakpoint
INSERT OR IGNORE INTO `bootstrap_state` (`id`, `status`) VALUES (1, 'empty');
--> statement-breakpoint

-- 2. Workspaces, Members, Invites
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint

CREATE TABLE `members` (
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`workspace_id`, `user_id`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `members_user` ON `members` (`user_id`);
--> statement-breakpoint

CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by` text,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_hash_uq` ON `invites` (`token_hash`);
--> statement-breakpoint

-- 3. Projects and Project Files
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`color` text,
	`position` text NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `projects_ws` ON `projects` (`workspace_id`,`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_projects_id_workspace` ON `projects` (`id`, `workspace_id`);
--> statement-breakpoint

CREATE TABLE `project_files` (
	`project_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`content_type` text NOT NULL,
	`filename` text,
	`byte_size` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `storage_key`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `project_files_storage_key_idx` ON `project_files` (`storage_key`);
--> statement-breakpoint

-- 4. Notepads
CREATE TABLE `notepads` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`parent_id` text,
	`kind` text DEFAULT 'notepad' NOT NULL,
	`title` text DEFAULT 'Untitled' NOT NULL,
	`icon` text,
	`cover_key` text,
	`content` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`position` text NOT NULL,
	`is_favorite` integer DEFAULT false NOT NULL,
	`deleted_at` integer,
	`deletion_operation_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `notepads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`, `workspace_id`) REFERENCES `projects`(`id`, `workspace_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notepads_tree` ON `notepads` (`project_id`,`parent_id`,`position`);
--> statement-breakpoint
CREATE INDEX `notepads_deleted_idx` ON `notepads` (`project_id`,`deleted_at`);
--> statement-breakpoint
CREATE INDEX `notepads_project_deleted_position_idx` ON `notepads` (`project_id`,`deleted_at`,`position`);
--> statement-breakpoint
CREATE INDEX `notepads_deletion_operation_idx` ON `notepads` (`deletion_operation_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notepads_id_kind` ON `notepads` (`id`, `kind`);
--> statement-breakpoint

-- FTS5 virtual table
CREATE VIRTUAL TABLE IF NOT EXISTS notepads_fts USING fts5(
  notepad_id UNINDEXED,
  project_id UNINDEXED,
  title,
  body
);
--> statement-breakpoint

-- 5. Boards, Board Columns, Cards
CREATE TABLE `boards` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`position` text NOT NULL,
	`deleted_at` integer,
	`deletion_operation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`, `workspace_id`) REFERENCES `projects`(`id`, `workspace_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `boards_project` ON `boards` (`project_id`,`position`);
--> statement-breakpoint

CREATE TABLE `board_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`position` text NOT NULL,
	`wip_limit` integer,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `columns_board` ON `board_columns` (`board_id`,`position`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_board_columns_id_board` ON `board_columns` (`id`, `board_id`);
--> statement-breakpoint

CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`column_id` text NOT NULL,
	`notepad_id` text NOT NULL,
	`kind` text DEFAULT 'card' NOT NULL CHECK (kind = 'card'),
	`position` text NOT NULL,
	`priority` text,
	`due_date` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`column_id`) REFERENCES `board_columns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`notepad_id`) REFERENCES `notepads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`column_id`, `board_id`) REFERENCES `board_columns`(`id`, `board_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`notepad_id`, `kind`) REFERENCES `notepads`(`id`, `kind`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cards_notepad_id_unique` ON `cards` (`notepad_id`);
--> statement-breakpoint
CREATE INDEX `cards_column` ON `cards` (`column_id`,`position`);
--> statement-breakpoint

CREATE TABLE `card_assignees` (
	`card_id` text NOT NULL,
	`user_id` text NOT NULL,
	`assigned_at` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`card_id`, `user_id`),
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE TABLE `card_subtasks` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`title` text NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`position` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subtasks_card` ON `card_subtasks` (`card_id`,`position`);
--> statement-breakpoint

CREATE TABLE `card_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`user_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comments_card` ON `card_comments` (`card_id`,`created_at`);
--> statement-breakpoint

-- 6. Tags & Notepad Tags
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_project_name_uq` ON `tags` (`project_id`,`name`);
--> statement-breakpoint

CREATE TABLE `notepad_tags` (
	`notepad_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`notepad_id`, `tag_id`),
	FOREIGN KEY (`notepad_id`) REFERENCES `notepads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

-- 7. Notepad Links
CREATE TABLE `notepad_links` (
	`source_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	PRIMARY KEY(`source_id`, `target_type`, `target_id`),
	FOREIGN KEY (`source_id`) REFERENCES `notepads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `links_target` ON `notepad_links` (`target_type`,`target_id`);
--> statement-breakpoint

-- 8. Notifications & Edit Locks
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`actor_id` text NOT NULL,
	`notepad_id` text,
	`card_id` text,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`notepad_id`) REFERENCES `notepads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_user` ON `notifications` (`user_id`,`read_at`,`created_at`);
--> statement-breakpoint

CREATE TABLE `edit_locks` (
	`notepad_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`notepad_id`) REFERENCES `notepads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

-- 9. Scope Cascade Guards
CREATE TRIGGER projects_scope_delete_guard
BEFORE DELETE ON projects
WHEN EXISTS (
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
)
BEGIN
  SELECT RAISE(ABORT, 'scope_cascade_conflict');
END;
--> statement-breakpoint

CREATE TRIGGER notepads_scope_delete_guard
BEFORE DELETE ON notepads
WHEN EXISTS (
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
)
BEGIN
  SELECT RAISE(ABORT, 'scope_cascade_conflict');
END;
--> statement-breakpoint

CREATE TRIGGER boards_scope_delete_guard
BEFORE DELETE ON boards
WHEN EXISTS (
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
)
BEGIN
  SELECT RAISE(ABORT, 'scope_cascade_conflict');
END;
--> statement-breakpoint

CREATE TRIGGER board_columns_scope_delete_guard
BEFORE DELETE ON board_columns
WHEN EXISTS (
  SELECT 1 FROM cards c
  WHERE c.column_id = OLD.id AND c.board_id <> OLD.board_id
)
BEGIN
  SELECT RAISE(ABORT, 'scope_cascade_conflict');
END;
--> statement-breakpoint

-- 10. Scope Write Guards
CREATE TRIGGER notepads_scope_insert_guard
BEFORE INSERT ON notepads
WHEN NOT EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.project_id AND p.workspace_id = NEW.workspace_id
) OR (NEW.parent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM notepads parent
  WHERE parent.id = NEW.parent_id
    AND parent.project_id = NEW.project_id
    AND parent.workspace_id = NEW.workspace_id
)) OR (NEW.kind = 'card' AND NEW.parent_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER notepads_scope_update_guard
BEFORE UPDATE OF project_id, workspace_id, parent_id, kind ON notepads
WHEN NOT EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.project_id AND p.workspace_id = NEW.workspace_id
) OR (NEW.parent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM notepads parent
  WHERE parent.id = NEW.parent_id
    AND parent.project_id = NEW.project_id
    AND parent.workspace_id = NEW.workspace_id
)) OR EXISTS (
  SELECT 1 FROM notepads child
  WHERE child.parent_id = OLD.id
    AND (child.project_id <> NEW.project_id OR child.workspace_id <> NEW.workspace_id)
) OR EXISTS (
  SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
  JOIN projects p ON p.id = b.project_id
  WHERE c.notepad_id = OLD.id
    AND (NEW.kind <> 'card' OR NEW.project_id <> p.id OR NEW.workspace_id <> p.workspace_id)
) OR (NEW.kind = 'card' AND NEW.parent_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER projects_scope_update_guard
BEFORE UPDATE OF workspace_id ON projects
WHEN EXISTS (SELECT 1 FROM notepads n WHERE n.project_id = OLD.id AND n.workspace_id <> NEW.workspace_id)
  OR EXISTS (SELECT 1 FROM boards b WHERE b.project_id = OLD.id AND b.workspace_id <> NEW.workspace_id)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER boards_scope_insert_guard
BEFORE INSERT ON boards
WHEN NOT EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.project_id AND p.workspace_id = NEW.workspace_id
)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER boards_scope_update_guard
BEFORE UPDATE OF project_id, workspace_id ON boards
WHEN NOT EXISTS (
  SELECT 1 FROM projects p
  WHERE p.id = NEW.project_id AND p.workspace_id = NEW.workspace_id
) OR EXISTS (
  SELECT 1 FROM cards c
  LEFT JOIN board_columns col ON col.id = c.column_id
  LEFT JOIN notepads n ON n.id = c.notepad_id
  WHERE c.board_id = OLD.id
    AND (col.id IS NULL OR col.board_id <> OLD.id OR n.id IS NULL OR n.kind <> 'card'
      OR n.project_id <> NEW.project_id OR n.workspace_id <> NEW.workspace_id)
)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER cards_scope_insert_guard
BEFORE INSERT ON cards
WHEN NOT EXISTS (
  SELECT 1 FROM boards b
  JOIN board_columns col ON col.id = NEW.column_id AND col.board_id = NEW.board_id
  JOIN projects p ON p.id = b.project_id AND p.workspace_id = b.workspace_id
  JOIN notepads n ON n.id = NEW.notepad_id AND n.kind = 'card'
    AND n.project_id = p.id AND n.workspace_id = p.workspace_id
  WHERE b.id = NEW.board_id
)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

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
--> statement-breakpoint

CREATE TRIGGER notepad_tags_scope_insert_guard
BEFORE INSERT ON notepad_tags
WHEN NOT EXISTS (
  SELECT 1 FROM notepads n JOIN tags t ON t.id = NEW.tag_id
  WHERE n.id = NEW.notepad_id AND n.project_id = t.project_id
)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER notepad_tags_scope_update_guard
BEFORE UPDATE OF notepad_id, tag_id ON notepad_tags
WHEN NOT EXISTS (
  SELECT 1 FROM notepads n JOIN tags t ON t.id = NEW.tag_id
  WHERE n.id = NEW.notepad_id AND n.project_id = t.project_id
)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER tags_scope_update_guard
BEFORE UPDATE OF project_id ON tags
WHEN EXISTS (
  SELECT 1 FROM notepad_tags nt JOIN notepads n ON n.id = nt.notepad_id
  WHERE nt.tag_id = OLD.id AND n.project_id <> NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER notepad_links_scope_insert_guard
BEFORE INSERT ON notepad_links
WHEN NOT EXISTS (
  SELECT 1 FROM notepads source
  WHERE source.id = NEW.source_id AND (
    (NEW.target_type = 'notepad' AND EXISTS (
      SELECT 1 FROM notepads target WHERE target.id = NEW.target_id
        AND target.project_id = source.project_id AND target.workspace_id = source.workspace_id
    )) OR (NEW.target_type = 'card' AND EXISTS (
      SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
      JOIN projects p ON p.id = b.project_id
      JOIN notepads body ON body.id = c.notepad_id
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
)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER notepad_links_scope_update_guard
BEFORE UPDATE OF source_id, target_type, target_id ON notepad_links
WHEN NOT EXISTS (
  SELECT 1 FROM notepads source
  WHERE source.id = NEW.source_id AND (
    (NEW.target_type = 'notepad' AND EXISTS (
      SELECT 1 FROM notepads target WHERE target.id = NEW.target_id
        AND target.project_id = source.project_id AND target.workspace_id = source.workspace_id
    )) OR (NEW.target_type = 'card' AND EXISTS (
      SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
      JOIN projects p ON p.id = b.project_id
      JOIN notepads body ON body.id = c.notepad_id
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
)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER card_assignees_scope_insert_guard
BEFORE INSERT ON card_assignees
WHEN NOT EXISTS (
  SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
  JOIN members m ON m.workspace_id = b.workspace_id AND m.user_id = NEW.user_id
  WHERE c.id = NEW.card_id
)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER card_assignees_scope_update_guard
BEFORE UPDATE OF card_id, user_id ON card_assignees
WHEN NOT EXISTS (
  SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
  JOIN members m ON m.workspace_id = b.workspace_id AND m.user_id = NEW.user_id
  WHERE c.id = NEW.card_id
)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER card_comments_scope_insert_guard
BEFORE INSERT ON card_comments
WHEN NOT EXISTS (
  SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
  JOIN members m ON m.workspace_id = b.workspace_id AND m.user_id = NEW.user_id
  WHERE c.id = NEW.card_id
)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER card_comments_scope_update_guard
BEFORE UPDATE OF card_id, user_id ON card_comments
WHEN NOT EXISTS (
  SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
  JOIN members m ON m.workspace_id = b.workspace_id AND m.user_id = NEW.user_id
  WHERE c.id = NEW.card_id
)
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER notifications_scope_insert_guard
BEFORE INSERT ON notifications
WHEN NOT EXISTS (
  SELECT 1 FROM members m WHERE m.workspace_id = NEW.workspace_id AND m.user_id = NEW.user_id
) OR (NEW.notepad_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM notepads n WHERE n.id = NEW.notepad_id AND n.workspace_id = NEW.workspace_id
)) OR (NEW.card_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
  WHERE c.id = NEW.card_id AND b.workspace_id = NEW.workspace_id
))
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

CREATE TRIGGER notifications_scope_update_guard
BEFORE UPDATE OF workspace_id, user_id, notepad_id, card_id ON notifications
WHEN NOT EXISTS (
  SELECT 1 FROM members m WHERE m.workspace_id = NEW.workspace_id AND m.user_id = NEW.user_id
) OR (NEW.notepad_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM notepads n WHERE n.id = NEW.notepad_id AND n.workspace_id = NEW.workspace_id
)) OR (NEW.card_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM cards c JOIN boards b ON b.id = c.board_id
  WHERE c.id = NEW.card_id AND b.workspace_id = NEW.workspace_id
))
BEGIN SELECT RAISE(ABORT, 'scope_write_conflict'); END;
--> statement-breakpoint

-- 11. User delete cascades (for SQLite runtime)
CREATE TRIGGER user_delete_cascades
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
--> statement-breakpoint

-- 12. Cleanup notepad_links targets on delete
CREATE TRIGGER notepads_cleanup_links AFTER DELETE ON notepads
BEGIN DELETE FROM notepad_links WHERE target_type = 'notepad' AND target_id = OLD.id; END;
--> statement-breakpoint

CREATE TRIGGER cards_cleanup_links AFTER DELETE ON cards
BEGIN DELETE FROM notepad_links WHERE target_type = 'card' AND target_id = OLD.id; END;
--> statement-breakpoint

CREATE TRIGGER boards_cleanup_links AFTER DELETE ON boards
BEGIN DELETE FROM notepad_links WHERE target_type = 'board' AND target_id = OLD.id; END;
--> statement-breakpoint

-- 13. Workspace Member Removal Cascades
CREATE TRIGGER members_cleanup_workspace_assignments
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
--> statement-breakpoint

-- 10. User Deletion Guard (Prevents deleting sole owner)
CREATE TRIGGER IF NOT EXISTS trg_prevent_sole_owner_user_delete
BEFORE DELETE ON `user`
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM members m1
  WHERE m1.user_id = OLD.id AND m1.role = 'owner'
  AND NOT EXISTS (
    SELECT 1 FROM members m2
    WHERE m2.workspace_id = m1.workspace_id
      AND m2.user_id <> OLD.id
      AND m2.role = 'owner'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'cannot_delete_sole_owner: user is the sole owner of one or more workspaces');
END;

