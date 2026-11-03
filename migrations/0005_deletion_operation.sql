ALTER TABLE `boards` ADD `deletion_operation_id` text;--> statement-breakpoint
ALTER TABLE `notepads` ADD `deletion_operation_id` text;--> statement-breakpoint
CREATE INDEX `notepads_deletion_operation_idx` ON `notepads` (`deletion_operation_id`);