import {deduplicatePurchasePlans} from "./purchase-plan-engine.js";
import {retainsPurchaseSnapshot} from "./purchase-snapshot-retention.js";
import {mergePurchaseBatches} from "./purchase-batch-policy.js";

// One creation projection for page history and server-side daily risk checks.
export function purchaseHistorySnapshot(record) {
  if (!retainsPurchaseSnapshot(record) || !record.planSet) return null;
  return {snapshotId:record.snapshotId,scheduledAt:record.scheduledAt,capturedAt:record.capturedAt,
    sourceFetchedAt:record.sourceFetchedAt,predictionId:record.predictionId,contentHash:record.contentHash,
    previousSnapshotId:record.previousSnapshotId,planSet:{...record.planSet,capturedAt:record.capturedAt,
      completedAt:record.completedAt||record.capturedAt,inputDecisionAt:record.inputDecisionAt,
      sourceFetchedAt:record.sourceFetchedAt,baseModelVersion:record.planSet.baseModelVersion||record.predictionVersion?.baseModelVersion,
      calibrationVersion:record.planSet.calibrationVersion||record.predictionVersion?.calibrationVersion,
      snapshotId:record.snapshotId,contentHash:record.contentHash}};
}

export function mergePurchaseHistorySnapshots(records) {
  const normalized=(records||[]).filter(record=>record&&typeof record==="object"&&record.snapshotId)
    .map(record=>({...record,planSet:{...record.planSet,snapshotId:String(record.snapshotId),plans:deduplicatePurchasePlans(record.planSet?.plans||[])}}));
  // Check frozen creation facts before collapsing source copies. Settlement-only
  // changes may merge; altered choices, probabilities or stake must fail closed.
  const batches=mergePurchaseBatches(normalized.map(record=>record.planSet));
  if(batches.conflicts.length)throw new Error(`历史快照投注原始内容冲突：${batches.conflicts.join(", ")}`);
  return [...new Map(normalized.map(record=>[String(record.snapshotId),record])).values()]
    .sort((a,b)=>String(b.capturedAt||"").localeCompare(String(a.capturedAt||"")));
}

/** @param {{bundled?:Array<Record<string,unknown>>,readDisk:()=>Promise<Array<Record<string,unknown>>>,readCloud:()=>Promise<Array<Record<string,unknown>>>}} sources */
export async function loadPurchaseHistorySources({bundled=[],readDisk,readCloud}) {
  // Fail closed on a storage error rather than silently omitting today's stake.
  const [disk,cloud]=await Promise.all([readDisk(),readCloud()]);
  return mergePurchaseHistorySnapshots([...bundled,...disk,...cloud]);
}
