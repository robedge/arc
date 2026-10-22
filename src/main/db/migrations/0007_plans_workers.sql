CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`status` text NOT NULL,
	`workers_json` text NOT NULL,
	`message_id` integer,
	`replaced_by_id` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plans_session_idx` ON `plans` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `worker_commits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worker_id` text NOT NULL,
	`project_id` text,
	`sha` text NOT NULL,
	`subject` text NOT NULL,
	`committed_at` integer NOT NULL,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `worker_commits_worker_idx` ON `worker_commits` (`worker_id`,`id`);--> statement-breakpoint
CREATE TABLE `worker_worktrees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worker_id` text NOT NULL,
	`project_id` text,
	`path` text NOT NULL,
	`base_sha` text NOT NULL,
	`head_sha` text NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `worker_worktrees_project_idx` ON `worker_worktrees` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `worker_worktrees_worker_project_unq` ON `worker_worktrees` (`worker_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `workers` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`number` integer NOT NULL,
	`slug` text NOT NULL,
	`task` text NOT NULL,
	`project_ids_json` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`activity` text,
	`failure_reason` text,
	`summary` text,
	`claude_session_id` text,
	`plan_id` text,
	`depends_on_json` text DEFAULT '[]' NOT NULL,
	`stopped_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workers_session_status_idx` ON `workers` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `workers_status_idx` ON `workers` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `workers_session_number_unq` ON `workers` (`session_id`,`number`);