import { researchHash } from "./forward-validation.js";
import { verifyPurchasePlanCompletion } from "./purchase-plan-engine.js";
import { purchaseCaptureWindow } from "./capture-window.js";

/** Completion is a separate immutable observation, never a rewrite of raw inputs. */
export function cloudCaptureReceipt(raw, persistedAt, { recovered = false } = {}) {
  const at = Date.parse(persistedAt), captured = Date.parse(raw?.capturedAt), target = Date.parse(raw?.scheduledAt);
  if (!raw?.immutable || !raw.snapshotId || !["raw-prediction-snapshot", "purchase-plan-snapshot"].includes(raw.recordType) ||
    ![at, captured, target].every(Number.isFinite) || at < captured)
    throw new Error("线上原始快照完成时间或身份无效");
  let executionEligible = true, executionReason = null;
  try {
    if (raw.recordType === "purchase-plan-snapshot") {
      const scheduled = new Date(target + 8 * 3600000).toISOString(), date = scheduled.slice(0, 10), slot = scheduled.slice(11, 16).replace(":", "");
      if (!purchaseCaptureWindow(date, slot, at, true).allowed) throw new Error("完成回读时固定票采集窗口已关闭");
      verifyPurchasePlanCompletion(raw.planSet, raw.officialMatches, persistedAt);
    } else {
      if (!(raw.reports?.length > 0) || raw.reports.some(report => !(Date.parse(report.kickoffAt) > at)))
        throw new Error("完成回读时比赛已开赛或开赛时间无法核验");
      for (const report of raw.reports) {
        const match = raw.officialMatches?.find(row => String(row.officialMatchId || row.matchId) === String(report.officialMatchId));
        if (!match || String(match.matchStatus).toLowerCase() !== "selling") throw new Error("完成回读时官方销售资格无法核验");
        const markets = Object.values(match.marketEligibility || {}).filter(row => row.qualification === "qualified");
        if (!markets.length || markets.some(row => String(row.salesStatus).toLowerCase() !== "selling" || !(Date.parse(row.cutoffAt || match.kickoffAt) > at)))
          throw new Error("完成回读时官方玩法已停售或截止时间无法核验");
      }
    }
  } catch (error) { executionEligible = false; executionReason = error.message; }
  const timing = recovered ? "recovered-unverified-timing" : at > target ? "delayed-batch" : "on-time";
  return { recordType: "cloud-raw-receipt", immutable: true, snapshotId: raw.snapshotId,
    rawHash: researchHash(raw), persistedAt, scheduledAt: raw.scheduledAt, decisionTiming: timing,
    recovered, executionEligible, executionReason,
    includedInStrictEvaluation: !recovered && executionEligible && timing === "on-time" && captured >= target - 15 * 60000 };
}

export function verifyCloudCaptureReceipt(raw, receipt) {
  if (!receipt || typeof receipt.recovered !== "boolean") throw new Error("线上原始快照完成凭证缺失或无效");
  const expected = cloudCaptureReceipt(raw, receipt.persistedAt, { recovered: receipt.recovered });
  if (researchHash(expected) !== researchHash(receipt)) throw new Error("线上原始快照完成凭证不一致");
  return receipt;
}

export function verifyCloudCaptureReceiptRecord(raw, record) {
  if (!record || record.id !== `raw-receipt-${raw.snapshotId}` || record.type !== "receipt" ||
    record.observedAt !== record.payload?.persistedAt)
    throw new Error("线上完成凭证元数据与原始快照不一致");
  return verifyCloudCaptureReceipt(raw, record.payload);
}

export function verifyCloudRawRecord(record) {
  const raw = record?.payload;
  const type = raw?.recordType === "purchase-plan-snapshot" ? "purchase" :
    raw?.recordType === "raw-prediction-snapshot" ? "raw" : null;
  if (!type || record.id !== raw.snapshotId || record.type !== type || record.observedAt !== raw.capturedAt)
    throw new Error("线上原始快照元数据与内容不一致");
  return raw;
}

export async function appendCloudCaptureReceipt(store, raw, persistedAt, options) {
  const id = `raw-receipt-${raw.snapshotId}`, previous = await store.read(id);
  if (previous) return verifyCloudCaptureReceiptRecord(raw, previous);
  const receipt = cloudCaptureReceipt(raw, persistedAt, options);
  try { await store.append({ id, type: "receipt", observedAt: persistedAt, payload: receipt }); }
  catch (error) {
    if (error.code === "CLOUD_LEASE_LOST") throw error;
    // Two genuine retries may observe the same orphan. Only accept the winner
    // after a complete readback; never overwrite either immutable timestamp.
    const winner = await store.read(id);
    if (!winner) throw error;
    return verifyCloudCaptureReceiptRecord(raw, winner);
  }
  return verifyCloudCaptureReceiptRecord(raw, await store.read(id));
}

export async function recoverCloudCaptureReceipts(store, clock) {
  const recovered = [];
  for (const type of ["raw", "purchase"]) for await (const record of store.scan(type)) {
    const raw = verifyCloudRawRecord(record);
    const receipt = await store.read(`raw-receipt-${raw.snapshotId}`);
    if (receipt) { verifyCloudCaptureReceiptRecord(raw, receipt); continue; }
    // The active writer's in-progress raw is not an orphan. Only an older
    // fenced generation (or pre-lease legacy evidence) may be recovered.
    if (!store.canRecover || !store.canRecover(record)) continue;
    const saved = await appendCloudCaptureReceipt(store, raw, clock(), { recovered: true });
    recovered.push({ snapshotId: saved.snapshotId, persistedAt: saved.persistedAt,
      executionEligible: saved.executionEligible, includedInStrictEvaluation: false });
  }
  return recovered;
}
