CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `brain_threads` (
	`session_id` text NOT NULL,
	`provider` text NOT NULL,
	`thread_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `provider`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `brain_provider` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `workers_pref_json` text DEFAULT '{"mode":"auto"}' NOT NULL;--> statement-breakpoint
ALTER TABLE `workers` ADD `provider` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `workers` ADD `requested_provider` text;--> statement-breakpoint
ALTER TABLE `workers` ADD `fallback_reason` text;--> statement-breakpoint
ALTER TABLE `workers` RENAME COLUMN `claude_session_id` TO `provider_session_id`;--> statement-breakpoint
UPDATE `sessions` SET `workers_pref_json` = CASE WHEN `model` IS NULL OR `model` = 'auto' THEN '{"mode":"auto"}' ELSE json_object('mode', 'model', 'model', json_object('provider', 'claude', 'model', `model`)) END;--> statement-breakpoint
INSERT INTO `brain_threads` (`session_id`, `provider`, `thread_id`, `updated_at`) SELECT `id`, 'claude', `brain_claude_session_id`, `last_active_at` FROM `sessions` WHERE `brain_claude_session_id` IS NOT NULL;
