CREATE TABLE `saved_purchase_trials` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`lottery_date` text NOT NULL,
	`created_at` text NOT NULL,
	`payload_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_saved_purchase_trials_user_created` ON `saved_purchase_trials` (`user_id`,`created_at`);