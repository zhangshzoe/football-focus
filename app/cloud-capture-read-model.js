import { verifyCloudCaptureReceiptRecord, verifyCloudRawRecord } from "./cloud-capture-receipt.js";

// Immutable raw records do not know when their write finished. The separate
// verified receipt supplies actual completion for every UI/strict projection.
export async function cloudCaptureReadModel(store, { projectRaw, projectPurchase }) {
  const snapshots = [], purchases = [], probabilitySnapshots = [], auditPurchases = [], latestAttempts = new Map();
  let bytes = 0;
  const project = async (record, converter, output) => {
    const raw = verifyCloudRawRecord(record), receiptRecord = await store.read(`raw-receipt-${raw.snapshotId}`);
    if (!receiptRecord) return;
    const receipt = verifyCloudCaptureReceiptRecord(raw, receiptRecord);
    // Raw evidence is retained for audit, but an expired purchase is not an
    // executable formal batch and must not enter cash recommendation statistics.
    const excludedPurchase = raw.recordType === "purchase-plan-snapshot" && !receipt.executionEligible;
    if (excludedPurchase) {
      auditPurchases.push({ snapshotId: raw.snapshotId, scheduledAt: raw.scheduledAt, capturedAt: raw.capturedAt,
        persistedAt: receipt.persistedAt, recovered: receipt.recovered, reason: receipt.executionReason,
        formalRecommendationEligible: false, includedInStrictEvaluation: false });
    }
    const projected = converter({ ...raw, capturedAt: receipt.persistedAt, completedAt: receipt.persistedAt,
      inputCapturedAt: raw.capturedAt, decisionTiming: receipt.decisionTiming, captureTiming: receipt.decisionTiming });
    if (projected) {
      const value = { ...projected,
        ...(projected.evaluationSnapshot ? { evaluationSnapshot: { ...projected.evaluationSnapshot,
          includedInStrictEvaluation: receipt.includedInStrictEvaluation, recovered: receipt.recovered } } : {}),
        storageOrigin: "cloud", inputCapturedAt: raw.capturedAt,
        persistedAt: receipt.persistedAt, executionEligible: receipt.executionEligible,
        executionReason: receipt.executionReason, recovered: receipt.recovered,
        includedInStrictEvaluation: receipt.includedInStrictEvaluation };
      bytes += new TextEncoder().encode(JSON.stringify(value)).length;
      if (bytes > 24 * 1024 * 1024) throw new Error("线上历史超过单次安全读取容量；未返回截断历史");
      if (raw.recordType === "purchase-plan-snapshot" && value.evaluationSnapshot)
        probabilitySnapshots.push({ ...value.evaluationSnapshot, storageOrigin: "cloud",
          inputCapturedAt: raw.capturedAt, persistedAt: receipt.persistedAt,
          executionEligible: receipt.executionEligible, executionReason: receipt.executionReason,
          recovered: receipt.recovered, includedInStrictEvaluation: receipt.includedInStrictEvaluation });
      if (!excludedPurchase) output.push(value);
    }
  };
  if (projectRaw) for await (const record of store.scan("raw")) await project(record, projectRaw, snapshots);
  for await (const record of store.scan("purchase")) await project(record, projectPurchase, purchases);
  for await (const record of store.scan("source-attempt")) {
    const row = record.payload;
    latestAttempts.set(`${row.salesDate}|${row.kind}|${row.slot}`, row);
  }
  return { snapshots, purchases, probabilitySnapshots, auditPurchases, attempts: [...latestAttempts.values()] };
}
