CREATE TABLE `review_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`session_project_id` integer NOT NULL,
	`path` text NOT NULL,
	`side` text NOT NULL,
	`line` integer NOT NULL,
	`line_text` text NOT NULL,
	`body` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`message_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_project_id`) REFERENCES `session_projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "review_notes_side_check" CHECK("review_notes"."side" IN ('old','new')),
	CONSTRAINT "review_notes_line_check" CHECK("review_notes"."line" > 0),
	CONSTRAINT "review_notes_line_text_check" CHECK(length("review_notes"."line_text") <= 500),
	CONSTRAINT "review_notes_body_check" CHECK(length("review_notes"."body") BETWEEN 1 AND 4000),
	CONSTRAINT "review_notes_state_check" CHECK("review_notes"."state" IN ('draft','sent'))
);
--> statement-breakpoint
CREATE INDEX `review_notes_project_path_idx` ON `review_notes` (`session_project_id`,`path`);--> statement-breakpoint
CREATE INDEX `review_notes_drafts_idx` ON `review_notes` (`session_project_id`) WHERE "review_notes"."state" = 'draft';