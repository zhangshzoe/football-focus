import { ticketFixtureKey, ticketPickLabel } from "./ticket-economics.js";

// Creation facts only: later settlements must not change a batch's identity.
const creationKey = set => JSON.stringify({
  date: set.date, generatedAt: set.generatedAt, scheduledTime: set.scheduledTime,
  decisionPolicy: set.decisionPolicy, baseModelVersion: set.baseModelVersion,
  calibrationVersion: set.calibrationVersion, inputHash: set.inputHash,
  noBet: set.decisionSummary?.noBet,
  plans: (set.plans || []).filter(p => p.status !== "unavailable").map(p => ({
    id: p.originPlanId || p.id, stake: p.stake, passName: p.passName,
    items: (p.items || []).map(i => ({fixture: ticketFixtureKey(i), market: i.market,
      picks: (i.picks || i.scores || [i]).map(pick => [ticketPickLabel(pick), pick.odd, pick.probability]).sort(),
    })).sort((a,b) => String(a.fixture).localeCompare(String(b.fixture))),
  })).sort((a,b) => String(a.id).localeCompare(String(b.id))),
});
export const purchaseBatchIdentity = set => String(set.snapshotId || set.trialId ||
  `${set.date || ""}|${set.scheduledTime || ""}|${set.generatedAt || ""}|${set.predictionId || "legacy"}`);

export function mergePurchaseBatches(sets) {
  const groups = new Map(), conflicts = [], duplicates = [];
  for (const set of sets || []) {
    if (!set || !Array.isArray(set.plans)) continue;
    const key = purchaseBatchIdentity(set), previous = groups.get(key);
    if (!previous) groups.set(key, {set, fingerprint: creationKey(set), conflict: false});
    else if (previous.fingerprint !== creationKey(set)) {
      previous.conflict = true;
      if (!conflicts.includes(key)) conflicts.push(key);
    } else duplicates.push(key);
  }
  return {planSets: [...groups.values()].filter(g => !g.conflict).map(g => g.set), conflicts,
    duplicateCount: duplicates.length};
}

export function collectEarlierPurchasePlans(sets, date) {
  const merged = mergePurchaseBatches((sets || []).filter(set => set.date === date && set.scheduledTime === "17:00"));
  if (merged.conflicts.length) return {status: "invalid", recordCount: 0, plans: [], conflicts: merged.conflicts};
  const earlier = merged.planSets.filter(set => set.date === date && set.scheduledTime === "17:00");
  const plans = [];
  for (const set of earlier) {
    const actual = set.plans.filter(p => p.status !== "unavailable");
    if (!actual.length && !(set.decisionSummary?.evaluated === true && set.decisionSummary?.noBet === true))
      return {status: "invalid", recordCount: earlier.length, plans: [], conflicts: [purchaseBatchIdentity(set)]};
    for (const plan of actual) plans.push({...plan, priorBatchId: purchaseBatchIdentity(set)});
  }
  return {status: earlier.length ? "verified" : "missing", recordCount: earlier.length, plans, conflicts: []};
}
