import { mergeFirstObservedResults } from "./forward-validation.js";

// Serving a page never replays expensive frozen models. New or conflicting
// evidence suspends eligibility until the offline index has been regenerated.
export function researchValidationView(index, liveEvents, now) {
  const bundled = index.resultEvents || [];
  const merged = mergeFirstObservedResults([...bundled, ...liveEvents], { now });
  const invalidResultEvents = [...(index.invalidResultEvents || []), ...merged.invalid];
  const unsyncedResultEvents = merged.records.filter(record =>
    !bundled.some(known => known.eventId === record.eventId && known.contentHash === record.contentHash)
  ).length;
  const previous = index.evaluation || { status: "not-frozen", eligible: false, sampleSize: 0 };
  const evaluation = invalidResultEvents.length
    ? { ...previous, status: "result-integrity-failed", eligible: false, reason: "赛果证据校验失败，暂停验证资格" }
    : unsyncedResultEvents && index.manifest
      ? { ...previous, status: "results-awaiting-replay", eligible: false, reason: "新赛果待离线冻结输入重放" }
      : previous;
  return {
    manifest: index.manifest || null, evaluation, evaluatedAt: index.evaluatedAt || null,
    resultEvents: merged.records, invalidResultEvents,
    resultEventCount: merged.records.length, unsyncedResultEvents,
  };
}
