CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`worker_id` text,
	`data_json` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_session_id_idx` ON `events` (`session_id`,`id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`state` text NOT NULL,
	`plan_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_session_id_idx` ON `messages` (`session_id`,`id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text,
	`mode` text NOT NULL,
	`worker_limit` integer NOT NULL,
	`model` text DEFAULT 'auto' NOT NULL,
	`status` text NOT NULL,
	`brain_claude_session_id` text,
	`created_at` integer NOT NULL,
	`last_active_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sessions_worker_limit_check" CHECK("sessions"."worker_limit" BETWEEN 1 AND 6)
);
--> statement-breakpoint
CREATE INDEX `sessions_group_last_active_idx` ON `sessions` (`group_id`,"last_active_at" DESC);