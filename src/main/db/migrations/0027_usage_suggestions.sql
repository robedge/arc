CREATE TABLE `session_file_reads` (
	`session_id` text NOT NULL,
	`agent_key` text NOT NULL,
	`path` text NOT NULL,
	`read_count` integer NOT NULL,
	`last_read_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `agent_key`, `path`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `usage_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_key` text,
	`worker_id` text,
	`dedupe_key` text NOT NULL,
	`text` text NOT NULL,
	`advice` text NOT NULL,
	`params_json` text NOT NULL,
	`usage_day` text NOT NULL,
	`created_at` integer NOT NULL,
	`dismissed_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "usage_suggestions_kind_check" CHECK("usage_suggestions"."kind" IN ('model_too_strong','setup_overhead','repeated_work','long_running'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_suggestions_dedupe_key_unique` ON `usage_suggestions` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `usage_suggestions_session_idx` ON `usage_suggestions` (`session_id`);--> statement-breakpoint
CREATE INDEX `usage_suggestions_dismissed_created_idx` ON `usage_suggestions` (`dismissed_at`,`created_at`);