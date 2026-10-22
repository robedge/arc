CREATE TABLE `session_allow_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`category` text NOT NULL,
	`tool` text NOT NULL,
	`prefix` text NOT NULL,
	`folder` text,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_allow_rules_session_idx` ON `session_allow_rules` (`session_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `auto_approve` integer DEFAULT false NOT NULL;