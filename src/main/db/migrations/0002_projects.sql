CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`display_name` text NOT NULL,
	`is_git` integer DEFAULT false NOT NULL,
	`last_seen_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_unique` ON `projects` (`path`);--> statement-breakpoint
CREATE TABLE `group_projects` (
	`group_id` text NOT NULL,
	`project_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `project_id`),
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `group_projects_project_idx` ON `group_projects` (`project_id`);