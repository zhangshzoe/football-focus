CREATE TABLE `research_capture_leases` (
	`scope_key` text PRIMARY KEY NOT NULL,
	`owner_token` text NOT NULL,
	`fence` integer NOT NULL,
	`lease_until` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `research_capture_records` ADD `writer_scope` text;--> statement-breakpoint
ALTER TABLE `research_capture_records` ADD `writer_token` text;--> statement-breakpoint
ALTER TABLE `research_capture_records` ADD `writer_fence` integer;--> statement-breakpoint
ALTER TABLE `research_capture_records` ADD `parent_id` text;--> statement-breakpoint
ALTER TABLE `research_capture_records` ADD `parent_hash` text;--> statement-breakpoint
ALTER TABLE `research_capture_records` ADD `receipt_recovered` integer;--> statement-breakpoint
ALTER TABLE `research_capture_runs` ADD `owner_token` text;--> statement-breakpoint
ALTER TABLE `research_capture_runs` ADD `fence` integer;--> statement-breakpoint
ALTER TABLE `research_result_events` ADD `writer_scope` text;--> statement-breakpoint
ALTER TABLE `research_result_events` ADD `writer_token` text;--> statement-breakpoint
ALTER TABLE `research_result_events` ADD `writer_fence` integer;
--> statement-breakpoint
CREATE TRIGGER `research_capture_records_fenced_insert` BEFORE INSERT ON `research_capture_records`
WHEN NOT EXISTS (SELECT 1 FROM research_capture_leases l WHERE l.scope_key = NEW.writer_scope
  AND l.owner_token = NEW.writer_token AND l.fence = NEW.writer_fence AND l.lease_until > unixepoch())
BEGIN SELECT RAISE(ABORT, 'expired research writer lease'); END;
--> statement-breakpoint
CREATE TRIGGER `research_receipts_fenced_parent` BEFORE INSERT ON `research_capture_records`
WHEN NEW.record_type = 'receipt' AND (NEW.parent_id IS NULL OR NEW.receipt_recovered IS NULL OR
  NOT EXISTS (SELECT 1 FROM research_capture_records p WHERE p.id = NEW.parent_id AND p.content_hash = NEW.parent_hash
    AND ((NEW.receipt_recovered = 0 AND p.writer_scope = NEW.writer_scope AND p.writer_token = NEW.writer_token AND p.writer_fence = NEW.writer_fence)
      OR (NEW.receipt_recovered = 1 AND (p.writer_fence IS NULL OR (p.writer_scope = NEW.writer_scope AND p.writer_fence < NEW.writer_fence))))))
BEGIN SELECT RAISE(ABORT, 'unverified research receipt parent'); END;
--> statement-breakpoint
CREATE TRIGGER `research_results_fenced_insert` BEFORE INSERT ON `research_result_events`
WHEN NOT EXISTS (SELECT 1 FROM research_capture_leases l WHERE l.scope_key = NEW.writer_scope
  AND l.owner_token = NEW.writer_token AND l.fence = NEW.writer_fence AND l.lease_until > unixepoch())
BEGIN SELECT RAISE(ABORT, 'expired research writer lease'); END;
--> statement-breakpoint
CREATE TRIGGER `research_runs_fenced_complete` BEFORE UPDATE ON `research_capture_runs`
WHEN NEW.status = 'complete' AND (NOT EXISTS (SELECT 1 FROM research_capture_leases l
  WHERE l.scope_key = 'research-writer' AND l.owner_token = NEW.owner_token AND l.fence = NEW.fence AND l.lease_until > unixepoch())
  OR NOT EXISTS (SELECT 1 FROM research_capture_records r WHERE r.id = json_extract(NEW.result_json, '$.attemptId')
    AND r.record_type = 'source-attempt' AND r.writer_scope = 'research-writer' AND r.writer_token = NEW.owner_token AND r.writer_fence = NEW.fence))
BEGIN SELECT RAISE(ABORT, 'unverified research run completion'); END;
--> statement-breakpoint
CREATE TRIGGER `research_lease_no_delete` BEFORE DELETE ON `research_capture_leases`
BEGIN SELECT RAISE(ABORT, 'research fence must remain monotonic'); END;
--> statement-breakpoint
CREATE TRIGGER `research_lease_monotonic` BEFORE UPDATE ON `research_capture_leases`
WHEN NEW.fence < OLD.fence OR (NEW.fence = OLD.fence AND NEW.owner_token != OLD.owner_token)
BEGIN SELECT RAISE(ABORT, 'research fence must remain monotonic'); END;
--> statement-breakpoint
CREATE TRIGGER `research_result_events_no_update` BEFORE UPDATE ON `research_result_events`
BEGIN SELECT RAISE(ABORT, 'immutable research result evidence'); END;
--> statement-breakpoint
CREATE TRIGGER `research_result_events_no_delete` BEFORE DELETE ON `research_result_events`
BEGIN SELECT RAISE(ABORT, 'immutable research result evidence'); END;
