ALTER TABLE `prediction_jobs` ADD `prediction_id` text;--> statement-breakpoint
ALTER TABLE `prediction_jobs` ADD `prediction_sales_dates` text;--> statement-breakpoint
ALTER TABLE `prediction_jobs` ADD `prediction_generated_at` text;--> statement-breakpoint
CREATE INDEX `idx_prediction_jobs_version` ON `prediction_jobs` (`prediction_id`);--> statement-breakpoint
CREATE INDEX `idx_prediction_jobs_latest` ON `prediction_jobs` (`namespace`,`prediction_generated_at`);