// Explicit one-off promotion approved by the owner. Keep the original trial ID and
// capture time: this is a formal statistical record, not a fabricated 17:00 run.
export const PROMOTED_PURCHASE_TRIAL = Object.freeze({
  snapshotId: "manual-trial-b606a0ed-2823-4fff-a4eb-ac299ab0fe5b",
  date: "2026-09-26",
  generatedAt: "2026-09-26T09:39:38.380Z",
});

export function promoteSavedPurchaseTrial(trial, formalDates = []) {
  const approved = PROMOTED_PURCHASE_TRIAL;
  if (
    !trial ||
    trial.snapshotId !== approved.snapshotId ||
    trial.date !== approved.date ||
    trial.generatedAt !== approved.generatedAt ||
    formalDates.includes(approved.date) ||
    !Array.isArray(trial.plans)
  ) return null;

  const available = trial.plans.filter((plan) => plan.status !== "unavailable" && plan.items?.length);
  if (!available.length || !available.every((plan) => plan.items.every((item) => {
    const picks = item.picks?.length ? item.picks : [item];
    return Boolean(item.officialMatchId) &&
      item.salesDate === approved.date &&
      item.matchStatus === "Selling" &&
      Number.isFinite(Date.parse(item.sourceFetchedAt || "")) &&
      Date.parse(item.sourceFetchedAt) <= Date.parse(approved.generatedAt) &&
      Date.parse(approved.generatedAt) - Date.parse(item.sourceFetchedAt) <= 60 * 60 * 1000 &&
      Number.isFinite(Date.parse(item.cutoffAt || "")) &&
      Date.parse(item.cutoffAt) > Date.parse(approved.generatedAt) &&
      Number.isFinite(Date.parse(item.kickoffAt || "")) &&
      Date.parse(item.kickoffAt) > Date.parse(approved.generatedAt) &&
      picks.every((pick) => Number.isFinite(Number(pick.odd)) && Number(pick.odd) > 0);
  }))) return null;

  return {
    ...trial,
    promotionKind: "manual-exception",
    source: "经用户确认转入正式统计的手动试算；实际采集于北京时间 2026-09-26 17:39，非 17:00 自动快照",
  };
}
