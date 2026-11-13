CREATE TABLE `message_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` integer NOT NULL,
	`session_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`name` text NOT NULL,
	`stored_name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "message_attachments_kind_check" CHECK("message_attachments"."kind" IN ('image','pdf','text')),
	CONSTRAINT "message_attachments_size_check" CHECK("message_attachments"."size_bytes" BETWEEN 1 AND 20971520)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_attachments_message_position_unq` ON `message_attachments` (`message_id`,`position`);--> statement-breakpoint
ALTER TABLE `workers` ADD `attachments_json` text;