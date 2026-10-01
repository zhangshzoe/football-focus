CREATE TABLE `research_capture_records` (
	`id` text PRIMARY KEY NOT NULL,
	`record_type` text NOT NULL,
	`observed_at` text NOT NULL,
	`content_hash` text NOT NULL,
	`object_key` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_research_capture_type_observed` ON `research_capture_records` (`record_type`,`observed_at`);--> statement-breakpoint
CREATE TABLE `research_capture_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`started_at` text NOT NULL,
	`status` text NOT NULL,
	`result_json` text
);
--> statement-breakpoint
CREATE TRIGGER `research_capture_records_no_update` BEFORE UPDATE ON `research_capture_records` BEGIN SELECT RAISE(ABORT, 'immutable research evidence'); END;
--> statement-breakpoint
CREATE TRIGGER `research_capture_records_no_delete` BEFORE DELETE ON `research_capture_records` BEGIN SELECT RAISE(ABORT, 'immutable research evidence'); END;
