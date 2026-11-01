CREATE TABLE `cloud_handoff_batches` (
	`key` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`status` text NOT NULL,
	`owner_token` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text,
	`failure_code` text,
	CONSTRAINT "cloud_handoff_batches_status" CHECK(status IN ('running', 'complete', 'failed', 'missed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cloud_handoff_one_running_per_namespace` ON `cloud_handoff_batches` (`namespace`) WHERE status = 'running';--> statement-breakpoint
CREATE TABLE `cloud_handoff_records` (
	`namespace` text NOT NULL,
	`record_kind` text NOT NULL,
	`record_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`object_key` text NOT NULL,
	`observed_at` text NOT NULL,
	`metadata_json` text NOT NULL,
	PRIMARY KEY(`namespace`, `record_kind`, `record_id`)
);
--> statement-breakpoint
CREATE TRIGGER `cloud_handoff_records_no_update` BEFORE UPDATE ON `cloud_handoff_records`
BEGIN SELECT RAISE(ABORT, 'immutable cloud handoff evidence'); END;
--> statement-breakpoint
CREATE TRIGGER `cloud_handoff_records_no_delete` BEFORE DELETE ON `cloud_handoff_records`
BEGIN SELECT RAISE(ABORT, 'immutable cloud handoff evidence'); END;
--> statement-breakpoint
CREATE TRIGGER `cloud_handoff_batches_no_delete` BEFORE DELETE ON `cloud_handoff_batches`
BEGIN SELECT RAISE(ABORT, 'cloud batch identity is permanent'); END;
--> statement-breakpoint
CREATE TRIGGER `cloud_handoff_batches_terminal` BEFORE UPDATE ON `cloud_handoff_batches`
WHEN OLD.status IN ('complete', 'failed', 'missed')
BEGIN SELECT RAISE(ABORT, 'terminal cloud batch cannot retry'); END;
--> statement-breakpoint
CREATE TRIGGER `cloud_handoff_batches_owner` BEFORE UPDATE ON `cloud_handoff_batches`
WHEN NEW.key != OLD.key OR NEW.namespace != OLD.namespace OR NEW.owner_token != OLD.owner_token OR NEW.started_at != OLD.started_at
BEGIN SELECT RAISE(ABORT, 'cloud batch owner and identity are immutable'); END;
