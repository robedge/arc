CREATE TABLE `usage_turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text,
	`agent_key` text NOT NULL,
	`agent_role` text NOT NULL,
	`worker_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`command` text,
	`session_name` text,
	`group_id` text,
	`group_name` text,
	`worker_label` text,
	`at` integer NOT NULL,
	`day` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`cache_write_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`max_call_input` integer DEFAULT 0 NOT NULL,
	`call_count` integer DEFAULT 0 NOT NULL,
	`context_window` integer,
	`setup_tokens` integer DEFAULT 0 NOT NULL,
	`arc_setup_tokens` integer DEFAULT 0 NOT NULL,
	`source` text DEFAULT 'turn' NOT NULL,
	`turn_key` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "usage_turns_role_check" CHECK("usage_turns"."agent_role" IN ('brain','worker','resolver','plan_check')),
	CONSTRAINT "usage_turns_source_check" CHECK("usage_turns"."source" IN ('turn','helper','partial')),
	CONSTRAINT "usage_turns_input_check" CHECK("usage_turns"."input_tokens" >= 0),
	CONSTRAINT "usage_turns_cache_write_check" CHECK("usage_turns"."cache_write_tokens" >= 0),
	CONSTRAINT "usage_turns_cache_read_check" CHECK("usage_turns"."cache_read_tokens" >= 0),
	CONSTRAINT "usage_turns_output_check" CHECK("usage_turns"."output_tokens" >= 0)
);
--> statement-breakpoint
CREATE INDEX `usage_turns_day_idx` ON `usage_turns` (`day`);--> statement-breakpoint
CREATE INDEX `usage_turns_session_agent_idx` ON `usage_turns` (`session_id`,`agent_key`);--> statement-breakpoint
CREATE INDEX `usage_turns_provider_model_day_idx` ON `usage_turns` (`provider`,`model`,`day`);--> statement-breakpoint
CREATE UNIQUE INDEX `usage_turns_turn_key_uq` ON `usage_turns` (`agent_key`,`turn_key`) WHERE "usage_turns"."turn_key" IS NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `app_settings` (`key`, `value_json`, `updated_at`) VALUES ('usage.trackingStartedAt', CAST(CAST(strftime('%s', 'now') AS integer) * 1000 AS text), CAST(strftime('%s', 'now') AS integer) * 1000);
