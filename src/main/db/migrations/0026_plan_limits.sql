CREATE TABLE `plan_limits` (
	`provider` text NOT NULL,
	`window` text NOT NULL,
	`label` text NOT NULL,
	`used_percent` real NOT NULL,
	`resets_at` integer,
	`observed_at` integer NOT NULL,
	`source` text NOT NULL,
	`plan_type` text,
	PRIMARY KEY(`provider`, `window`),
	CONSTRAINT "plan_limits_source_check" CHECK("plan_limits"."source" IN ('event','probe','poll','push'))
);
--> statement-breakpoint
CREATE TABLE `plan_notices` (
	`key` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`window` text NOT NULL,
	`threshold` integer NOT NULL,
	`resets_at` integer,
	`notified_at` integer NOT NULL,
	`dismissed_at` integer,
	CONSTRAINT "plan_notices_threshold_check" CHECK("plan_notices"."threshold" IN (80,95))
);
