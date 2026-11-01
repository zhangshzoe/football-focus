// Existing tables reconstructed from applied migration 0006 metadata.
// Keep declarations complete: omissions would make Drizzle propose destructive drops.
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const predictionJobs = sqliteTable("prediction_jobs", {
  id: text("id").primaryKey().notNull(),
  namespace: text("namespace").notNull(),
  inputFingerprint: text("input_fingerprint").notNull(),
  inputIdentityJson: text("input_identity_json").notNull(),
  codeHash: text("code_hash").notNull(),
  codeIdentityJson: text("code_identity_json").notNull(),
  preparedObjectKey: text("prepared_object_key").notNull(),
  preparedHash: text("prepared_hash").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  firstStartedAt: integer("first_started_at"),
  startedAt: integer("started_at"),
  completedAt: integer("completed_at"),
  ownerToken: text("owner_token"),
  fence: integer("fence").notNull().default(0),
  leaseUntil: integer("lease_until"),
  resultObjectKey: text("result_object_key"),
  resultHash: text("result_hash"),
  predictionId: text("prediction_id"),
  predictionSalesDates: text("prediction_sales_dates"),
  predictionGeneratedAt: text("prediction_generated_at"),
  failureCode: text("failure_code"),
}, (table) => [
  index("idx_prediction_jobs_claim").on(table.namespace, table.status, table.expiresAt, table.leaseUntil, table.createdAt, table.id),
  index("idx_prediction_jobs_expiry").on(table.expiresAt, table.status),
  index("idx_prediction_jobs_version").on(table.predictionId),
  index("idx_prediction_jobs_latest").on(table.namespace, table.predictionGeneratedAt),
  uniqueIndex("prediction_jobs_namespace_input_code_unique").on(table.namespace, table.inputFingerprint, table.codeIdentityJson),
  check("prediction_jobs_namespace", sql.raw("\"prediction_jobs\".\"namespace\" IN ('official', 'research')")),
  check("prediction_jobs_status", sql.raw("\"prediction_jobs\".\"status\" IN ('queued', 'running', 'ready', 'failed', 'expired')")),
  check("prediction_jobs_expiry", sql.raw("\"prediction_jobs\".\"expires_at\" > \"prediction_jobs\".\"created_at\"")),
  check("prediction_jobs_fence", sql.raw("\"prediction_jobs\".\"fence\" >= 0")),
  check("prediction_jobs_lease", sql.raw("(\"prediction_jobs\".\"status\" = 'running' AND \"prediction_jobs\".\"owner_token\" IS NOT NULL AND \"prediction_jobs\".\"lease_until\" IS NOT NULL) OR (\"prediction_jobs\".\"status\" != 'running' AND \"prediction_jobs\".\"owner_token\" IS NULL AND \"prediction_jobs\".\"lease_until\" IS NULL)")),
  check("prediction_jobs_result", sql.raw("(\"prediction_jobs\".\"result_object_key\" IS NULL) = (\"prediction_jobs\".\"result_hash\" IS NULL)")),
  check("prediction_jobs_ready", sql.raw("\"prediction_jobs\".\"status\" != 'ready' OR (\"prediction_jobs\".\"result_object_key\" IS NOT NULL AND \"prediction_jobs\".\"completed_at\" IS NOT NULL)")),
]);

export const predictionRuntimeState = sqliteTable("prediction_runtime_state", {
  key: text("key").primaryKey().notNull(),
  valueJson: text("value_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const researchCaptureLeases = sqliteTable("research_capture_leases", {
  scopeKey: text("scope_key").primaryKey().notNull(),
  ownerToken: text("owner_token").notNull(),
  fence: integer("fence").notNull(),
  leaseUntil: integer("lease_until").notNull(),
});

export const researchCaptureRecords = sqliteTable("research_capture_records", {
  id: text("id").primaryKey().notNull(),
  recordType: text("record_type").notNull(),
  observedAt: text("observed_at").notNull(),
  contentHash: text("content_hash").notNull(),
  objectKey: text("object_key").notNull(),
  writerScope: text("writer_scope"),
  writerToken: text("writer_token"),
  writerFence: integer("writer_fence"),
  parentId: text("parent_id"),
  parentHash: text("parent_hash"),
  receiptRecovered: integer("receipt_recovered"),
}, (table) => [
  index("idx_research_capture_type_observed").on(table.recordType, table.observedAt),
]);

export const researchCaptureRuns = sqliteTable("research_capture_runs", {
  id: text("id").primaryKey().notNull(),
  requestHash: text("request_hash").notNull(),
  startedAt: text("started_at").notNull(),
  status: text("status").notNull(),
  resultJson: text("result_json"),
  ownerToken: text("owner_token"),
  fence: integer("fence"),
});

export const researchResultEvents = sqliteTable("research_result_events", {
  id: text("id").primaryKey().notNull(),
  fixtureKey: text("fixture_key").notNull(),
  firstObservedAt: text("first_observed_at").notNull(),
  outcomeHash: text("outcome_hash").notNull(),
  payloadJson: text("payload_json").notNull(),
  writerScope: text("writer_scope"),
  writerToken: text("writer_token"),
  writerFence: integer("writer_fence"),
}, (table) => [
  index("idx_research_results_fixture_observed").on(table.fixtureKey, table.firstObservedAt),
]);

export const savedPurchaseTrials = sqliteTable("saved_purchase_trials", {
  id: text("id").primaryKey().notNull(),
  userId: text("user_id").notNull(),
  lotteryDate: text("lottery_date").notNull(),
  createdAt: text("created_at").notNull(),
  payloadJson: text("payload_json").notNull(),
}, (table) => [
  index("idx_saved_purchase_trials_user_created").on(table.userId, table.createdAt),
]);

// A batch is claimed at most once. No expired-lease reclaim or automatic retry.
export const cloudHandoffBatches = sqliteTable("cloud_handoff_batches", {
  key: text("key").primaryKey().notNull(),
  namespace: text("namespace").notNull(),
  status: text("status").notNull(),
  ownerToken: text("owner_token").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  failureCode: text("failure_code"),
}, (table) => [
  uniqueIndex("cloud_handoff_one_running_per_namespace").on(table.namespace).where(sql.raw("status = 'running'")),
  check("cloud_handoff_batches_status", sql.raw("status IN ('running', 'complete', 'failed', 'missed')")),
]);

// Raw objects are immutable; metadata identifies individual records, not whole indices.
export const cloudHandoffRecords = sqliteTable("cloud_handoff_records", {
  namespace: text("namespace").notNull(),
  recordKind: text("record_kind").notNull(),
  recordId: text("record_id").notNull(),
  contentHash: text("content_hash").notNull(),
  objectKey: text("object_key").notNull(),
  observedAt: text("observed_at").notNull(),
  metadataJson: text("metadata_json").notNull(),
}, (table) => [
  primaryKey({columns: [table.namespace, table.recordKind, table.recordId]}),
]);
