import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// Manually saved trials are distinct from immutable 17:00 purchase snapshots.
export const savedPurchaseTrials = sqliteTable(
  "saved_purchase_trials",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    lotteryDate: text("lottery_date").notNull(),
    createdAt: text("created_at").notNull(),
    payloadJson: text("payload_json").notNull(),
  },
  (table) => [index("idx_saved_purchase_trials_user_created").on(table.userId, table.createdAt)],
);

// Append-only research evidence. Runtime never changes an existing event.
export const researchResultEvents = sqliteTable(
  "research_result_events",
  {
    id: text("id").primaryKey(),
    fixtureKey: text("fixture_key").notNull(),
    firstObservedAt: text("first_observed_at").notNull(),
    outcomeHash: text("outcome_hash").notNull(),
    payloadJson: text("payload_json").notNull(),
    writerScope: text("writer_scope"),
    writerToken: text("writer_token"),
    writerFence: integer("writer_fence"),
  },
  (table) => [
    index("idx_research_results_fixture_observed").on(table.fixtureKey, table.firstObservedAt),
  ],
);

// Append-only evidence metadata. Full raw records live in content-addressed R2 objects.
export const researchCaptureRecords = sqliteTable(
  "research_capture_records",
  {
    id: text("id").primaryKey(),
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
  },
  (table) => [index("idx_research_capture_type_observed").on(table.recordType, table.observedAt)],
);

// Operational idempotency state is distinct from immutable evidence.
export const researchCaptureRuns = sqliteTable("research_capture_runs", {
  id: text("id").primaryKey(),
  requestHash: text("request_hash").notNull(),
  startedAt: text("started_at").notNull(),
  status: text("status").notNull(),
  resultJson: text("result_json"),
  ownerToken: text("owner_token"),
  fence: integer("fence"),
});

// Operational single-writer lease. The row and monotonic fence are never deleted.
export const researchCaptureLeases = sqliteTable("research_capture_leases", {
  scopeKey: text("scope_key").primaryKey(),
  ownerToken: text("owner_token").notNull(),
  fence: integer("fence").notNull(),
  leaseUntil: integer("lease_until").notNull(),
});

// Mutable compute jobs are not immutable research evidence or purchase records.
// Prepared inputs and numerical results are content-addressed objects in R2.
export const predictionJobs = sqliteTable(
  "prediction_jobs",
  {
    id: text("id").primaryKey(),
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
    failureCode: text("failure_code"),
  },
  (table) => [
    unique("prediction_jobs_namespace_input_code_unique").on(
      table.namespace,
      table.inputFingerprint,
      table.codeIdentityJson,
    ),
    index("idx_prediction_jobs_claim").on(
      table.namespace,
      table.status,
      table.expiresAt,
      table.leaseUntil,
      table.createdAt,
      table.id,
    ),
    index("idx_prediction_jobs_expiry").on(table.expiresAt, table.status),
    check("prediction_jobs_namespace", sql`${table.namespace} IN ('official', 'research')`),
    check(
      "prediction_jobs_status",
      sql`${table.status} IN ('queued', 'running', 'ready', 'failed', 'expired')`,
    ),
    check("prediction_jobs_expiry", sql`${table.expiresAt} > ${table.createdAt}`),
    check("prediction_jobs_fence", sql`${table.fence} >= 0`),
    check(
      "prediction_jobs_lease",
      sql`(${table.status} = 'running' AND ${table.ownerToken} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL) OR (${table.status} != 'running' AND ${table.ownerToken} IS NULL AND ${table.leaseUntil} IS NULL)`,
    ),
    check(
      "prediction_jobs_result",
      sql`(${table.resultObjectKey} IS NULL) = (${table.resultHash} IS NULL)`,
    ),
    check(
      "prediction_jobs_ready",
      sql`${table.status} != 'ready' OR (${table.resultObjectKey} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`,
    ),
  ],
);
