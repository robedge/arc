CREATE TABLE `attention_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`worker_id` text,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	`action` text,
	`reason` text,
	`question` text,
	`tool_name` text,
	`tool_input_json` text,
	`tool_use_id` text,
	`category` text,
	`must_escalate` integer DEFAULT false NOT NULL,
	`escalated` integer DEFAULT false NOT NULL,
	`brain_note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`answer` text,
	`delivered` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "attention_requests_content_check" CHECK("attention_requests"."action" IS NOT NULL OR "attention_requests"."question" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `attention_requests_pending_idx` ON `attention_requests` (`session_id`) WHERE "attention_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `attention_requests_status_idx` ON `attention_requests` (`status`);--> statement-breakpoint
CREATE INDEX `attention_requests_worker_idx` ON `attention_requests` (`worker_id`);