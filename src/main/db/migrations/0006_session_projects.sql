CREATE TABLE `session_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`project_id` text,
	`branch_name` text,
	`base_branch` text,
	`previous_branch` text,
	`read_only` integer DEFAULT false NOT NULL,
	`dirty_handling` text DEFAULT 'none' NOT NULL,
	`stash_ref` text,
	`project_path` text NOT NULL,
	`project_name` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `session_projects_project_idx` ON `session_projects` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_projects_session_project_unq` ON `session_projects` (`session_id`,`project_id`);