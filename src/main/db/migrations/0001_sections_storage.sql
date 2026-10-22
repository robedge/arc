CREATE TABLE `sections` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`folder_name` text,
	`sort_order` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sections_kind_check" CHECK("sections"."kind" IN ('projects','notes','docs','playbooks','links','custom'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sections_group_name_key_unique` ON `sections` (`group_id`,`name_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `sections_group_kind_builtin_unique` ON `sections` (`group_id`,`kind`) WHERE "sections"."kind" <> 'custom';--> statement-breakpoint
CREATE INDEX `sections_group_sort_idx` ON `sections` (`group_id`,`sort_order`);--> statement-breakpoint
CREATE TABLE `knowledge_storage` (
	`group_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`linked_path` text,
	`kept_aside` integer DEFAULT false NOT NULL,
	`pending_op` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "knowledge_storage_mode_check" CHECK("knowledge_storage"."mode" IN ('app','linked')),
	CONSTRAINT "knowledge_storage_linked_path_check" CHECK(("knowledge_storage"."mode" = 'linked') = ("knowledge_storage"."linked_path" IS NOT NULL))
);

--> statement-breakpoint
-- Hand-written backfill (drizzle-kit cannot express data changes): seed groups that predate this migration.
INSERT INTO `sections` (`id`, `group_id`, `kind`, `name`, `name_key`, `folder_name`, `sort_order`, `created_at`)
SELECT lower(hex(randomblob(16))), g.`id`, d.`kind`, d.`name`, lower(d.`name`), d.`folder`, d.`sort_order`, g.`created_at`
FROM `groups` g
CROSS JOIN (
	SELECT 'projects' AS `kind`, 'Projects' AS `name`, NULL AS `folder`, 0 AS `sort_order`
	UNION ALL SELECT 'notes', 'Notes', 'Notes', 1
	UNION ALL SELECT 'docs', 'Docs', 'Docs', 2
	UNION ALL SELECT 'playbooks', 'Playbooks', 'Playbooks', 3
	UNION ALL SELECT 'links', 'Links', 'Links', 4
) d
WHERE NOT EXISTS (
	SELECT 1 FROM `sections` s WHERE s.`group_id` = g.`id` AND s.`kind` = d.`kind`
);
--> statement-breakpoint
INSERT INTO `knowledge_storage` (`group_id`, `mode`, `linked_path`, `kept_aside`, `pending_op`, `updated_at`)
SELECT g.`id`, 'app', NULL, 0, NULL, g.`created_at`
FROM `groups` g
WHERE NOT EXISTS (SELECT 1 FROM `knowledge_storage` k WHERE k.`group_id` = g.`id`);
