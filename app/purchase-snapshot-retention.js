/** A verified no-bet is a real decision, not a missing capture or a losing ticket. */
export function retainsPurchaseSnapshot(record) {
  const plans = record?.planSet?.plans, summary = record?.planSet?.decisionSummary;
  if (record?.recordType !== "purchase-plan-snapshot" || record.immutable !== true ||
    !record.snapshotId || !Array.isArray(plans)) return false;
  // Preserve immutable legacy tickets; the new gate must not rewrite history.
  if (plans.length > 0) return true;
  return record.planSet.version >= 15 && summary?.evaluated === true && summary.noBet === true &&
    summary.coverage?.missingEligibleCount === 0;
}
