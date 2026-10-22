CREATE TABLE `knowledge_items` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`section_id` text NOT NULL,
	`rel_path` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`url` text,
	`mime` text,
	`size_bytes` integer NOT NULL,
	`mtime_ms` integer NOT NULL,
	`content_hash` text,
	`is_editable` integer NOT NULL,
	`indexed_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`section_id`) REFERENCES `sections`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_items_kind_check" CHECK("knowledge_items"."kind" IN ('note','playbook','doc_text','doc_binary','link','item'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_items_group_rel_path_unique` ON `knowledge_items` (`group_id`,`rel_path`);--> statement-breakpoint
CREATE INDEX `knowledge_items_section_idx` ON `knowledge_items` (`section_id`);