// Recommendation completeness is separate from strict forward-validation eligibility.
export function recommendationComplete(record) {
  const coverage = record.sourceCoverage;
  if (coverage) return coverage.eligible > 0 && coverage.predicted === coverage.eligible;
  return record.qualityStatus !== "partial" && Array.isArray(record.planSet?.plans) && record.planSet.plans.length > 0;
}
export function recommendationLabel(planSet) {
  const archiveSlot = analysisArchiveSlot(planSet);
  if (archiveSlot) return `${archiveSlot === "1700" ? "17:00" : "21:00"}档指定汇总（保留实际生成时间，非准时快照）`;
  return `${planSet.scheduledTime || "17:00"}推荐快照${planSet.captureTiming === "delayed" ? " · 延迟采集" : ""}${planSet.qualityStatus === "partial" ? " · 部分场次" : ""}${planSet.cutoffStatus === "unknown" ? " · 截止时间未知" : ""}`;
}
// User-requested analysis cohorts only: never mutate timestamps, identity or strict eligibility.
export function analysisArchiveSlot(planSet) {
  if (planSet.date !== "2026-10-09" || !Number.isFinite(Date.parse(planSet.generatedAt))) return null;
  const clock = new Intl.DateTimeFormat("en-GB", {timeZone:"Asia/Shanghai",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date(planSet.generatedAt));
  if (clock === "19:01" && planSet.snapshotId === "purchase-2026-10-09-190102-9bb04be49374") return "1700";
  if (clock === "19:55" && planSet.snapshotId?.startsWith("manual-trial-")) return "2100";
  return null;
}
