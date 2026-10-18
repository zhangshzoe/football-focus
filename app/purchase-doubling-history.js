import {
  deduplicatePurchasePlanSets,
  summarizePurchasePlanDefinitions,
  summarizePurchasePlans,
} from "./purchase-plan-engine.js";
import { analysisArchiveSlot } from "./purchase-snapshot-status.js";

// Owner-approved historical replay only. The stored trial is never rewritten.
export const APPROVED_DOUBLING_TRIAL = Object.freeze({
  snapshotId: "manual-trial-4dbbaedd-c89b-42c5-9cfe-69d4554b6b1e",
  date: "2026-10-16",
  generatedAt: "2026-10-16T09:19:06.549Z",
  scheduledTime: "17:00",
});

export function getApprovedDoublingTrial(trial) {
  if (!trial || Object.entries(APPROVED_DOUBLING_TRIAL).some(([key, value]) => trial[key] !== value)
    || !Array.isArray(trial.plans)) return null;
  const capturedAt = Date.parse(trial.generatedAt);
  const available = trial.plans.filter(plan => plan.status !== "unavailable" && plan.items?.length);
  if (!available.length || !available.every(plan => plan.items.every(item => {
    const fetchedAt = Date.parse(item.sourceFetchedAt || "");
    const cutoffAt = Date.parse(item.cutoffAt || "");
    const picks = item.picks?.length ? item.picks : [item];
    return Boolean(item.officialMatchId) && item.salesDate === trial.date && item.matchStatus === "Selling"
      && Number.isFinite(fetchedAt) && fetchedAt <= capturedAt && capturedAt - fetchedAt <= 3600000
      && Date.parse(item.kickoffAt || "") > capturedAt
      && (Number.isFinite(cutoffAt) ? cutoffAt > capturedAt : !item.cutoffAt && item.cutoffStatus === "unknown")
      && picks.every(pick => Number.isFinite(Number(pick.odd)) && Number(pick.odd) > 0);
  }))) return null;
  return { ...trial, includedInStrictEvaluation: false };
}

const slotOf = set => analysisArchiveSlot(set) || (set.scheduledTime === "21:00" ? "2100"
  : set.scheduledTime && set.scheduledTime !== "17:00" ? "current" : "1700");
const isManual = set => String(set.snapshotId || "").startsWith("manual-trial-");

export function buildPurchaseDoublingHistory(planSets = [], slot = "1700") {
  const validSets = planSets.filter(set => set && /^\d{4}-\d{2}-\d{2}$/.test(set.date || ""));
  const formal = validSets.filter(set => !isManual(set) || set.promotionKind === "manual-exception" || analysisArchiveSlot(set));
  const approved = validSets.map(getApprovedDoublingTrial).filter(set => set
    && !formal.some(other => other.date === set.date && slotOf(other) === "1700"));
  // Select whole capture batches before looking at individual methods or results.
  const batches = deduplicatePurchasePlanSets([...formal, ...approved]);
  const preferred = batches.filter(set => slotOf(set) === slot);
  const history = summarizePurchasePlanDefinitions(preferred);
  const fallback = slot === "2100"
    ? summarizePurchasePlanDefinitions(batches.filter(set => slotOf(set) === "1700")) : {};
  // An explicit no-bet or pending record is present, even when summary rows omit it.
  const present = new Set(preferred.flatMap(set => (set.plans || []).map(plan => `${set.date}|${plan.id}`)));
  return Object.fromEntries(Object.entries(history).map(([method, summary]) => {
    const decorate = (row, isFallback) => ({
      ...row,
      isFallback,
      manualTrial: row.snapshotId === APPROVED_DOUBLING_TRIAL.snapshotId,
    });
    const rows = [
      ...summary.rows.map(row => decorate(row, false)),
      ...(fallback[method]?.rows || []).filter(row => !present.has(`${row.date}|${method}`))
        .map(row => decorate(row, true)),
    ].sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
    return [method, { ...summarizePurchasePlans(rows.map(row => row.plan)), rows }];
  }));
}
