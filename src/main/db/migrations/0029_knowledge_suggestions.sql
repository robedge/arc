CREATE TABLE `knowledge_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`group_id` text NOT NULL,
	`request_id` text NOT NULL,
	`action` text NOT NULL,
	`title` text NOT NULL,
	`reason` text NOT NULL,
	`section_id` text NOT NULL,
	`section_name` text NOT NULL,
	`target_rel_path` text,
	`proposed_name` text,
	`proposed_content` text NOT NULL,
	`hunks_json` text,
	`base_revision` text,
	`dedupe_key` text NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`edited_content` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_suggestions_action_check" CHECK("knowledge_suggestions"."action" IN ('new','update')),
	CONSTRAINT "knowledge_suggestions_status_check" CHECK("knowledge_suggestions"."status" IN ('waiting','accepted','accepted_edited','discarded')),
	CONSTRAINT "knowledge_suggestions_target_check" CHECK(("knowledge_suggestions"."action" = 'new' AND "knowledge_suggestions"."proposed_name" IS NOT NULL) OR ("knowledge_suggestions"."action" = 'update' AND "knowledge_suggestions"."target_rel_path" IS NOT NULL)),
	CONSTRAINT "knowledge_suggestions_resolved_check" CHECK(("knowledge_suggestions"."status" = 'waiting') = ("knowledge_suggestions"."resolved_at" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_suggestions_dedupe_key_uq` ON `knowledge_suggestions` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `knowledge_suggestions_waiting_idx` ON `knowledge_suggestions` (`session_id`,`created_at`) WHERE "knowledge_suggestions"."status" = 'waiting';--> statement-breakpoint
CREATE INDEX `knowledge_suggestions_request_idx` ON `knowledge_suggestions` (`session_id`,`request_id`);