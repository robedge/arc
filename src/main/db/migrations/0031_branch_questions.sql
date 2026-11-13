CREATE TABLE `branch_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`session_project_id` integer NOT NULL,
	`status` text NOT NULL,
	`choice` text,
	`message` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_project_id`) REFERENCES `session_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "branch_questions_status_check" CHECK("branch_questions"."status" IN ('pending','answered','cancelled')),
	CONSTRAINT "branch_questions_choice_check" CHECK("branch_questions"."choice" IS NULL OR "branch_questions"."choice" IN ('stash','commit','carry','skip'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `branch_questions_pending_project_unq` ON `branch_questions` (`session_project_id`) WHERE "branch_questions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `branch_questions_pending_session_idx` ON `branch_questions` (`session_id`) WHERE "branch_questions"."status" = 'pending';