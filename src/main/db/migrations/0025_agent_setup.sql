CREATE TABLE `agent_setup` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` text NOT NULL,
	`agent_key` text NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`arc_additions_tokens` integer NOT NULL,
	`fixed_setup_tokens` integer,
	`estimated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_setup_session_agent_provider_uq` ON `agent_setup` (`session_id`,`agent_key`,`provider`);