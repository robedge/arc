CREATE TABLE `review_file_marks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_project_id` integer NOT NULL,
	`path` text NOT NULL,
	`fingerprint` text NOT NULL,
	`marked_at` integer NOT NULL,
	FOREIGN KEY (`session_project_id`) REFERENCES `session_projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_file_marks_project_path_unq` ON `review_file_marks` (`session_project_id`,`path`);