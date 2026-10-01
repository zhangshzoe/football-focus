CREATE TABLE `research_result_events` (
	`id` text PRIMARY KEY NOT NULL,
	`fixture_key` text NOT NULL,
	`first_observed_at` text NOT NULL,
	`outcome_hash` text NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_research_results_fixture_observed` ON `research_result_events` (`fixture_key`,`first_observed_at`);