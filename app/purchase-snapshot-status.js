// Recommendation completeness is separate from strict forward-validation eligibility.
export function recommendationComplete(record) {
  const coverage = record.sourceCoverage;
  if (coverage) return coverage.eligible > 0 && coverage.predicted === coverage.eligible;
  return record.qualityStatus !== "partial" && Array.isArray(record.planSet?.plans) && record.planSet.plans.length > 0;
}
export function recommendationLabel(planSet) {
  return `${planSet.scheduledTime || "17:00"}推荐快照${planSet.captureTiming === "delayed" ? " · 延迟采集" : ""}${planSet.qualityStatus === "partial" ? " · 部分场次" : ""}${planSet.cutoffStatus === "unknown" ? " · 截止时间未知" : ""}`;
}
