import { buildFirstObservedResult, verifyForwardManifest } from "./forward-validation.js";
import { decisionTargetAt } from "./snapshot-decision-policy.js";

// Only results belonging to a pre-frozen future cohort become research evidence.
// Ordinary historical results remain available for ticket settlement separately.
export function observeResearchResults({ results, fixtureUniverse, manifest, observedAt, sourcePage }) {
  if (!verifyForwardManifest(manifest)) return { status: "not-frozen", records: [], rejected: [] };
  const start = Date.parse(manifest.startAt), end = Date.parse(manifest.endAt);
  const fixtures = (fixtureUniverse || []).filter(fixture => {
    const target = Date.parse(decisionTargetAt(fixture?.salesDate, fixture?.kickoffAt) || "");
    return target >= start && target < end;
  });
  const records = [], rejected = [];
  for (const result of results || []) {
    const key = `${result.salesDate || result.date}|${result.officialMatchId || result.matchId}`;
    if (!fixtures.some(fixture => `${fixture.salesDate}|${fixture.officialMatchId}` === key)) continue;
    const observation = buildFirstObservedResult(result, fixtures, observedAt, sourcePage);
    if (observation.status === "verified") records.push(observation.record);
    else rejected.push({ key, reason: observation.reason });
  }
  return { status: "observed", records, rejected };
}
