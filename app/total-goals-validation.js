import { researchHash, mergeFirstObservedResults } from "./forward-validation.js";
import { verifyCloudCaptureReceipt } from "./cloud-capture-receipt.js";
import { PREDICTION_PIPELINE_VERSION } from "./prediction-model.js";
import { replayTotalGoals } from "./total-goals-evaluation.js";
import { selectDecisionObservations, decisionTargetAt } from "./snapshot-decision-policy.js";
import { scoreProbability, summarizeProbability, pairedInterval } from "./probability-evaluation.js";
import { settleTicket, calculateTicketEconomics, TICKET_SETTLEMENT_VERSION } from "./ticket-economics.js";

export const TOTAL_GOALS_VALIDATION_VERSION = "fixed-decision-ttg-replay-v1";
const labels = ["0球", "1球", "2球", "3球", "4球", "5球", "6球", "7+球"];
const keyOf = (r) => `${r.salesDate}|${r.officialMatchId}`;
const topTwo = (v) => v.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p || a.i - b.i).slice(0, 2).map((r) => r.i);
const increment = (counts, reason) => { counts[reason] = (counts[reason] || 0) + 1; };
const sameTime = (a, b) => Number.isFinite(Date.parse(a)) && Date.parse(a) === Date.parse(b);
function hasRealTimeEvidence(row, now) {
  const [captured, completed, generated, decision, fetched] =
    [row.capturedAt, row.completedAt, row.predictionGeneratedAt, row.modelInput?.decisionAt, row.sourceFetchedAt].map(Date.parse);
  return [captured, completed, generated, decision, fetched].every(Number.isFinite) &&
    Math.max(captured, completed, generated, decision, fetched) <= now &&
    fetched <= decision && decision <= generated && generated <= captured && captured <= completed;
}
const totalPlans = (set) => (set?.plans || []).filter((plan) => [2, 3].includes(plan.items?.length) && plan.items.every((leg) => ["total", "总进球数"].includes(leg.market) && (leg.picks || leg.scores)?.length === 2));
export function projectTotalGoalPurchase(raw, receipt) {
  return { snapshotId: raw.snapshotId, scheduledAt: raw.scheduledAt, capturedAt: receipt?.persistedAt || raw.capturedAt,
    planSet: { plans: totalPlans(raw.planSet) } };
}

// Only the offline job / fenced cloud writer calls this adapter. Completion
// comes from a hash-checked receipt, never scheduledAt or a browser timestamp.
export function projectTotalGoalRawSnapshot(raw, completion) {
  let receipt, completionReason = "missing-verified-completion";
  try { receipt = verifyCloudCaptureReceipt(raw, completion); completionReason = null; }
  catch { if (completion) completionReason = "invalid-completion-proof"; }
  const reports = raw.reports || raw.forecasts || [];
  return reports.map((report) => {
    const base = { snapshotId: raw.snapshotId, rawHash: researchHash(raw),
      officialMatchId: String(report.officialMatchId || ""), salesDate: report.salesDate,
      kickoffAt: report.kickoffAt, home: report.home, away: report.away,
      capturedAt: raw.capturedAt, completedAt: receipt?.persistedAt,
      sourceFetchedAt: report.sourceFetchedAt || raw.sourceFetchedAt,
      predictionGeneratedAt: report.predictionGeneratedAt,
      scheduledAt: raw.scheduledAt, calibrationVersion: report.calibrationVersion || raw.version?.calibrationVersion || raw.predictionVersion?.calibrationVersion,
      recovered: receipt?.recovered, includedInStrictEvaluation: receipt?.includedInStrictEvaluation,
      executionEligible: receipt?.executionEligible, recordType: raw.recordType,
      purchasePlanHash: raw.recordType === "purchase-plan-snapshot" ? researchHash(totalPlans(raw.planSet)) : null };
    let invalidReason = completionReason;
    if (!raw.immutable || !["raw-prediction-snapshot", "purchase-plan-snapshot"].includes(raw.recordType)) invalidReason = "non-immutable-source";
    else if (report.isMock || report.officialMappingStatus !== "verified") invalidReason = "unverified-fixture";
    else if (report.modelInput?.pipelineVersion !== PREDICTION_PIPELINE_VERSION) invalidReason = "incompatible-raw-version";
    else if (receipt?.recovered || receipt?.includedInStrictEvaluation !== true || receipt?.executionEligible !== true) invalidReason = completionReason || "delayed-or-recovered";
    const input = report.modelInput, official = input?.official;
    if (!invalidReason && (String(official?.officialMatchId) !== base.officialMatchId || official?.salesDate !== base.salesDate || !sameTime(official?.kickoffAt, base.kickoffAt))) invalidReason = "raw-identity-mismatch";
    const source = raw.officialSource;
    const decision = Date.parse(input?.decisionAt), pools = ["HAD", "HHAD", "CRS", "TTG", "HAFU"];
    if (!invalidReason && (source?.manifestState !== "complete" || pools.some((pool) => {
      const row = source.poolStatus?.[pool], at = Date.parse(row?.observedAt);
      return row?.status !== "success" || !Number.isFinite(at) || at > decision || decision - at > 300000;
    }))) invalidReason = "unverified-or-stale-official-pools";
    const match = raw.officialMatches?.find((m) => String(m.officialMatchId || m.matchId) === base.officialMatchId && m.salesDate === base.salesDate);
    const qualification = match?.marketEligibility?.["总进球数"];
    if (!invalidReason && (qualification?.qualification !== "qualified" || String(qualification.salesStatus).toLowerCase() !== "selling" || !(Date.parse(qualification.cutoffAt || match.kickoffAt) > Date.parse(base.completedAt)) || JSON.stringify(match.marketOdds?.["总进球数"]) !== JSON.stringify(official.totalOdds))) invalidReason = "unverified-total-market";
    if (!invalidReason && (!report.modelParameters || typeof report.modelParameters !== "object" || Array.isArray(report.modelParameters) || !base.calibrationVersion || !report.inputSnapshotId)) invalidReason = "missing-frozen-parameters";
    const stored = report.marketSignal?.modeledTotalGoals;
    if (!invalidReason && (!Array.isArray(stored) || stored.length !== 8 || stored.some((p) => typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 100) || Math.abs(stored.reduce((a, b) => a + b, 0) - 100) > 1e-6)) invalidReason = "incomplete-stored-total-distribution";
    // Legacy exclusions need no large model/grid payload in the online bundle.
    return invalidReason ? { ...base, invalidReason, modelInput: { decisionAt: input?.decisionAt } } : { ...base, modelInput: input,
      modelParameters: report.modelParameters, storedTotalProbabilities: stored,
      inputHash: report.inputSnapshotId, parametersHash: researchHash(report.modelParameters) };
  });
}

function resultMap(events, now) {
  const merged = mergeFirstObservedResults(events, { now }), groups = new Map();
  for (const event of merged.records) groups.set(event.fixtureKey, [...(groups.get(event.fixtureKey) || []), event]);
  return { groups, invalid: merged.invalid };
}

function replay(row, outcomes) {
  const events = outcomes.get(keyOf(row)) || [];
  if (!events.length) return { reason: "pending-verified-result" };
  if (new Set(events.map((e) => e.outcomeHash)).size !== 1) return { reason: "conflicting-verified-results" };
  const event = events[0], fixture = event.fixture;
  if (!sameTime(fixture.kickoffAt, row.kickoffAt) || fixture.home !== row.home || fixture.away !== row.away) return { reason: "result-fixture-mismatch" };
  const value = replayTotalGoals({ ...row, actualTotalGoals: event.homeGoals + event.awayGoals });
  if (value.status !== "ready") return { reason: value.reason };
  if (value.model.some((p, i) => Math.abs(p * 100 - row.storedTotalProbabilities[i]) > 1e-6)) return { reason: "stored-replay-mismatch" };
  const cohortId = `${value.pipelineVersion}|${row.calibrationVersion}|${row.parametersHash}`;
  return { row: { ...value, salesDate: row.salesDate, officialMatchId: row.officialMatchId,
    kickoffAt: row.kickoffAt, home: row.home, away: row.away, cohortId,
    resultEventId: event.eventId, resultAuthority: event.sourceAuthority,
    fullScore: event.fullScore, modelScore: scoreProbability(value.model, value.actual, true),
    marketScore: scoreProbability(value.market, value.actual, true) } };
}

function summarize(rows) {
  const paired = rows.map((r) => ({ key: r.key, salesDate: r.salesDate, model: r.modelScore, market: r.marketScore }));
  const dates = [...new Set(rows.map((r) => r.salesDate))].sort();
  return { sampleSize: rows.length, salesDays: dates.length, startDate: dates[0] || null, endDate: dates.at(-1) || null,
    model: summarizeProbability(rows.map((r) => r.modelScore)), market: summarizeProbability(rows.map((r) => r.marketScore)),
    differences: { brier: pairedInterval(paired), logLoss: pairedInterval(paired, "logLoss"), rps: pairedInterval(paired, "rps"),
      topTwoMiss: pairedInterval(rows.map((r) => ({ key: r.key, salesDate: r.salesDate,
        model: { brier: Number(r.modelScore.rank > 2) }, market: { brier: Number(r.marketScore.rank > 2) } }))) } };
}

function ticketComparison(rows) {
  const compare = (field) => {
    const legs = rows.map((row) => ({ officialMatchId: row.officialMatchId, salesDate: row.salesDate,
      scores: topTwo(row[field]).map((i) => ({ pick: labels[i], odd: row.odds[i], probability: row[field][i] * 100 })),
      actual: labels[row.actual], settlementState: "settled" }));
    const economics = calculateTicketEconomics(legs), settled = settleTicket(legs);
    return { selections: legs.map((l) => l.scores.map((p) => p.pick)), stake: settled.totalStake,
      returned: settled.returned, netProfit: settled.returned - settled.totalStake, won: settled.status === "won",
      expectedReturn: economics.expectedReturn, expectedProfit: economics.expectedProfit,
      estimatedHitProbability: legs.reduce((q, l) => q * l.scores.reduce((s, p) => s + p.probability / 100, 0), 1) };
  };
  return { model: compare("model"), market: compare("market") };
}

// Ticket cohort is separate from the per-fixture fixed target: a genuine 17/21
// purchase batch has its own frozen selection time. Do not reselect its games.
function savedTickets(purchases, observations, outcomes, now) {
  const rows = [], exclusions = {}, bySnapshot = new Map(), seen = new Set();
  for (const observation of observations) {
    const key = `${observation.snapshotId}|${keyOf(observation)}`;
    bySnapshot.set(key, [...(bySnapshot.get(key) || []), observation]);
  }
  for (const purchase of purchases) for (const plan of purchase.planSet?.plans || []) {
    const picks = (leg) => leg.picks || leg.scores;
    if (plan.status === "unavailable") continue;
    if (![2, 3].includes(plan.items?.length) || !plan.items.every((l) => ["total", "总进球数"].includes(l.market) && Array.isArray(picks(l)) && picks(l).length === 2)) continue;
    const chosen = [], reject = (reason) => increment(exclusions, reason);
    let reason;
    for (const leg of plan.items) {
      const sources = bySnapshot.get(`${purchase.snapshotId}|${leg.salesDate}|${leg.officialMatchId}`) || [];
      const source = sources[0];
      if (!source || sources.some((r) => r.rawHash !== source.rawHash)) { reason = "missing-or-conflicting-ticket-input"; break; }
      if (source.recordType !== "purchase-plan-snapshot" || source.purchasePlanHash !== researchHash(totalPlans(purchase.planSet))) { reason = "saved-ticket-provenance-mismatch"; break; }
      if (source.invalidReason) { reason = source.invalidReason; break; }
      if (!hasRealTimeEvidence(source, now)) { reason = "missing-or-invalid-real-times"; break; }
      if (!sameTime(purchase.capturedAt, source.completedAt) || !sameTime(purchase.scheduledAt, source.scheduledAt)) { reason = "saved-ticket-provenance-mismatch"; break; }
      const value = replay(source, outcomes);
      if (!value.row) { reason = value.reason; break; }
      const row = value.row, selections = topTwo(row.model);
      if (leg.picks && leg.scores || !selections.every((i) => picks(leg).some((p) => p.pick === labels[i] && p.odd === row.odds[i] && typeof p.probability === "number" && Math.abs(p.probability - row.model[i] * 100) < 1e-6)) || plan.stake !== 2 * 2 ** plan.items.length || plan.betCount !== 2 ** plan.items.length || !(plan.originPlanId || plan.id)) { reason = "saved-ticket-selection-or-cost-mismatch"; break; }
      chosen.push(row);
    }
    if (reason) { reject(reason); continue; }
    if (new Set(chosen.map((r) => r.key)).size !== chosen.length || new Set(chosen.map((r) => `${r.cohortId}|${Date.parse(r.decisionAt)}`)).size !== 1) { reject("mixed-or-repeated-ticket-input"); continue; }
    const ticketKey = researchHash([purchase.snapshotId, chosen.map((r) => r.key).sort()]);
    if (seen.has(ticketKey)) { reject("duplicate-saved-ticket"); continue; }
    seen.add(ticketKey);
    rows.push({ snapshotId: purchase.snapshotId, savedTicketId: plan.originPlanId || plan.id,
      sourceContentHash: chosen.length ? bySnapshot.get(`${purchase.snapshotId}|${keyOf(plan.items[0])}`)?.[0]?.rawHash : null,
      salesDate: chosen[0].salesDate,
      scheduledAt: purchase.scheduledAt, capturedAt: purchase.capturedAt,
      cohortId: chosen[0].cohortId, passName: `双选${chosen.length}串1`,
      fixtureKeys: chosen.map((r) => r.key), resultEventIds: chosen.map((r) => r.resultEventId), fixtures: chosen.map(({ home, away, fullScore }) => ({ home, away, fullScore })),
      ...ticketComparison(chosen) });
  }
  rows.sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || a.snapshotId.localeCompare(b.snapshotId));
  const cash = (selected, field) => ({ tickets: selected.length, won: selected.filter((r) => r[field].won).length,
    hitRate: selected.length ? selected.filter((r) => r[field].won).length / selected.length : null,
    stake: selected.length ? selected.reduce((n, r) => n + r[field].stake, 0) : null,
    returned: selected.length ? selected.reduce((n, r) => n + r[field].returned, 0) : null,
    netProfit: selected.length ? selected.reduce((n, r) => n + r[field].netProfit, 0) : null });
  const groups = [...new Set(rows.map((r) => `${r.cohortId}|${r.passName}`))].map((id) => {
    const selected = rows.filter((r) => `${r.cohortId}|${r.passName}` === id);
    return { id, cohortId: selected[0].cohortId, passName: selected[0].passName, model: cash(selected, "model"), market: cash(selected, "market") };
  });
  let overlappingTicketPairs = 0;
  rows.forEach((row, i) => rows.slice(i + 1).forEach((other) => { if (row.fixtureKeys.some((k) => other.fixtureKeys.includes(k))) overlappingTicketPairs++; }));
  return { sampleSize: rows.length, exclusions, groups, rows, overlappingTicketPairs,
    assumption: "independent-matches-not-independent-tickets", settlementVersion: TICKET_SETTLEMENT_VERSION };
}

export function buildTotalGoalsValidation({ observations = [], purchases = [], resultEvents = [], fixtureUniverse = [], sourceAttempts = [], now = Date.now() } = {}) {
  if (!Number.isFinite(now)) throw new Error("Validation time is required");
  const exclusions = {}, all = [], identities = new Map();
  // Same snapshot with conflicting bytes is an integrity failure, not a winner.
  const duplicates = new Map();
  for (const r of observations) { const k = `${r.snapshotId}|${keyOf(r)}`; duplicates.set(k, [...(duplicates.get(k) || []), r]); }
  for (const values of duplicates.values()) {
    const row = values[0];
    if (new Set(values.map((r) => r.rawHash)).size > 1) { increment(exclusions, "conflicting-raw-snapshot"); continue; }
    if (row.officialMatchId && row.salesDate) identities.set(keyOf(row), true);
    const target = Date.parse(decisionTargetAt(row.salesDate, row.kickoffAt));
    if (!hasRealTimeEvidence(row, now)) { increment(exclusions, row.invalidReason || "missing-or-invalid-real-times"); continue; }
    if (!Number.isFinite(target) || Date.parse(row.completedAt) > target || Date.parse(row.completedAt) >= Date.parse(row.kickoffAt)) { increment(exclusions, "after-fixed-decision"); continue; }
    all.push({ ...row, capturedAt: row.completedAt });
  }
  // Selection never sees outcomes or model/market scores.
  const selected = selectDecisionObservations(all);
  selected.excluded.forEach((e) => increment(exclusions, e.reason));
  const superseded = all.length - selected.rows.length - selected.excluded.length;
  if (superseded) exclusions["superseded-before-target"] = superseded;
  const results = resultMap(resultEvents, now), rows = [];
  for (const selectedRow of selected.rows) {
    if (selectedRow.invalidReason) { increment(exclusions, selectedRow.invalidReason); continue; }
    const value = replay(selectedRow, results.groups);
    if (value.row) rows.push(value.row); else increment(exclusions, value.reason);
  }
  rows.sort((a, b) => Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt) || a.key.localeCompare(b.key));
  const cohorts = [...new Set(rows.map((r) => r.cohortId))].map((id) => {
    const sample = rows.filter((r) => r.cohortId === id);
    return { id, windows: { all: summarize(sample), recent50: summarize(sample.slice(-50)), recent100: summarize(sample.slice(-100)) } };
  });
  const latest = [...sourceAttempts].sort((a, b) => Date.parse(a.completedAt || a.startedAt) - Date.parse(b.completedAt || b.startedAt)).at(-1);
  return { schemaVersion: 1, validationVersion: TOTAL_GOALS_VALIDATION_VERSION, pipelineVersion: PREDICTION_PIPELINE_VERSION,
    evaluatedAt: new Date(now).toISOString(), status: rows.length ? "diagnostic-only" : "no-comparable-samples", promotionEligible: false,
    policy: selected.policy, labels, attemptedRecords: observations.length, archivedFixtures: identities.size,
    eligibleBeforeResults: selected.rows.length, comparableMatches: rows.length, exclusions, invalidResultEvents: results.invalid.length,
    denominatorScope: "archived-fixtures-only", officialUniverseKnown: latest?.sourceState?.manifestState === "complete" && latest?.officialManifest?.length > 0 && fixtureUniverse.length > 0 && (latest.status || latest.outcome) !== "failed",
    latestSourceStatus: latest?.status || latest?.outcome || "unknown", latestSourceReason: latest?.reason || null,
    resultBasis: "verified-published-result-events-including-secondary-lottery-source", cohorts,
    tickets: savedTickets(purchases, observations, results.groups, now),
    rows: rows.map(({ modelScore, marketScore, ...r }) => r) };
}
