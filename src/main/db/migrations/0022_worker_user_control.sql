CREATE TABLE `worker_held_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worker_id` text NOT NULL,
	`session_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `worker_held_messages_worker_idx` ON `worker_held_messages` (`worker_id`,`delivered_at`);--> statement-breakpoint
ALTER TABLE `worker_worktrees` ADD `control_base_sha` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `user_control` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `control_started_at` integer;--> statement-breakpoint
ALTER TABLE `workers` ADD `control_user_messages` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workers` ADD `control_last_message` text;--> statement-breakpoint
ALTER TABLE `attention_requests` ADD `route` text DEFAULT 'queue' NOT NULL;