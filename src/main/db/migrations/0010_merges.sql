CREATE TABLE `merges` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`worker_id` text,
	`project_id` text,
	`result` text NOT NULL,
	`files_json` text NOT NULL,
	`conflict_files_json` text,
	`merge_sha` text,
	`notes` text,
	`merged_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `merges_session_idx` ON `merges` (`session_id`,`merged_at`);--> statement-breakpoint
CREATE INDEX `merges_worker_idx` ON `merges` (`worker_id`,`merged_at`);