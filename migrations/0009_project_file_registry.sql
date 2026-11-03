CREATE TABLE `project_files` (
	`project_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`content_type` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `storage_key`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_files_storage_key_idx` ON `project_files` (`storage_key`);