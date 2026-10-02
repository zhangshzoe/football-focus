CREATE TABLE `prediction_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`input_fingerprint` text NOT NULL,
	`input_identity_json` text NOT NULL,
	`code_hash` text NOT NULL,
	`code_identity_json` text NOT NULL,
	`prepared_object_key` text NOT NULL,
	`prepared_hash` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`first_started_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`owner_token` text,
	`fence` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`result_object_key` text,
	`result_hash` text,
	`failure_code` text,
	CONSTRAINT "prediction_jobs_namespace" CHECK("prediction_jobs"."namespace" IN ('official', 'research')),
	CONSTRAINT "prediction_jobs_status" CHECK("prediction_jobs"."status" IN ('queued', 'running', 'ready', 'failed', 'expired')),
	CONSTRAINT "prediction_jobs_expiry" CHECK("prediction_jobs"."expires_at" > "prediction_jobs"."created_at"),
	CONSTRAINT "prediction_jobs_fence" CHECK("prediction_jobs"."fence" >= 0),
	CONSTRAINT "prediction_jobs_lease" CHECK(("prediction_jobs"."status" = 'running' AND "prediction_jobs"."owner_token" IS NOT NULL AND "prediction_jobs"."lease_until" IS NOT NULL) OR ("prediction_jobs"."status" != 'running' AND "prediction_jobs"."owner_token" IS NULL AND "prediction_jobs"."lease_until" IS NULL)),
	CONSTRAINT "prediction_jobs_result" CHECK(("prediction_jobs"."result_object_key" IS NULL) = ("prediction_jobs"."result_hash" IS NULL)),
	CONSTRAINT "prediction_jobs_ready" CHECK("prediction_jobs"."status" != 'ready' OR ("prediction_jobs"."result_object_key" IS NOT NULL AND "prediction_jobs"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_prediction_jobs_claim` ON `prediction_jobs` (`namespace`,`status`,`expires_at`,`lease_until`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_prediction_jobs_expiry` ON `prediction_jobs` (`expires_at`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `prediction_jobs_namespace_input_code_unique` ON `prediction_jobs` (`namespace`,`input_fingerprint`,`code_identity_json`);