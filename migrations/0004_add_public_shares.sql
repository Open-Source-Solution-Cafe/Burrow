CREATE TABLE `public_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `public_shares_token_uq` ON `public_shares` (`token`);--> statement-breakpoint
CREATE UNIQUE INDEX `public_shares_target_uq` ON `public_shares` (`project_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `public_shares_ws_idx` ON `public_shares` (`workspace_id`);
