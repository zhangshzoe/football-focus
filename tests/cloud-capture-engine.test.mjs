import test from "node:test";
import assert from "node:assert/strict";
import { cloudCaptureEngine } from "../app/cloud-capture-engine.js";
import { authorizedCloudCapture, validateCloudCaptureJob } from "../app/cloud-capture-auth.js";
import { researchHash, freezeForwardManifest } from "../app/forward-validation.js";
import { expectedHalfFullDistribution } from "../app/half-full-validation.js";
import { cloudResearchStore } from "../app/cloud-research-store.js";
import { sqliteD1, researchDatabase } from "./helpers/cloud-sqlite-fixture.mjs";

// Isolated in-memory test doubles only; never write synthetic fixtures to data/.
function memoryStore(onAppend = () => {}) {
  const records = new Map(), runs = new Map();
  let fence = 0;
  const store = { records, async read(id) { return records.get(id) || null; },
    async append(record) { if (records.has(record.id)) throw new Error("test immutable conflict"); records.set(record.id, structuredClone(record)); onAppend(record); return record; },
    async *scan(type) { for (const record of [...records.values()]) if (record.type === type) yield record; },
    async list(type) { return [...records.values()].filter((record) => record.type === type); },
    async claim(job) { const previous = runs.get(job.id); if (previous) { if (previous.requestHash !== job.requestHash) throw new Error("job conflict"); return { claimed: false, status: previous.status, result: previous.result }; } runs.set(job.id, { ...job, status: "running" }); return { claimed: true, lease: { scope: "research-writer", token: "test-writer-token", fence: ++fence } }; },
    async complete(id, result) { runs.get(id).status = "complete"; runs.get(id).result = result; return result; },
    async renew() {}, async release() {},
    withLease(lease) { return { ...store, lease, async assertLease() {}, canRecover: record => !record.writer || record.writer.fence < lease.fence }; },
  };
  return store;
}
function harness({ at = "2026-10-02T12:50:00+08:00", sourceError, malformed, duringWrite, bundled = {}, storeOverride, beforeSource, changePredictionSource, emptySource = false } = {}) {
  let clock = at, calls = 0;
  const store = storeOverride || memoryStore((record) => { if (record.type === "raw" && duringWrite) clock = duringWrite; });
  const match = { id: "周五001", officialMatchId: "12345", matchId: "12345", salesDate: "2026-10-02", kickoffAt: "2026-10-02T13:30:00+08:00", matchStatus: "Selling", home: "Test home", away: "Test away", league: "Test league", odds: [2, 3, 4], marketOdds: { "总进球数": Array(8).fill(8), "比分": Array(31).fill(31), "半全场": Array(9).fill(9) }, marketEligibility: { "胜平负": { qualification: "qualified", salesStatus: "Selling", cutoffAt: "2026-10-02T13:30:00+08:00" }, "让球胜平负": { qualification: "unavailable" } } };
  const grid = Array.from({ length: 169 }, (_, i) => ({ score: `${Math.floor(i / 13)}:${i % 13}`, probability: 100 / 169 }));
  const totals = Array(8).fill(0);
  for (const point of grid) { const [h, a] = point.score.split(":").map(Number); totals[Math.min(7, h + a)] += point.probability; }
  const had = [100 * 78 / 169, 100 * 13 / 169, 100 * 78 / 169];
  const report = { ...match, officialMappingStatus: "verified", predictionId: "test-prediction", inputSnapshotId: "test-input", predictionGeneratedAt: at, sourceFetchedAt: at,
    oddsScores: grid, fullScoreDistribution: grid, probabilities: { home: 100 * 78 / 169, draw: 100 * 13 / 169, away: 100 * 78 / 169 },
    modelInput: { decisionAt: at, official: { officialMatchId: match.officialMatchId, salesDate: match.salesDate, kickoffAt: match.kickoffAt, fetchedAt: at, hadOdds: match.odds, handicap: null, hhadOdds: [], totalOdds: match.marketOdds["总进球数"], scoreOdds: match.marketOdds["比分"], halfFullOdds: match.marketOdds["半全场"] } },
    officialVerification: { method: "server-refetch", fetchedAt: at },
    modelParameters: { firstHalfGoalShare: .45 },
    marketSignal: { modeledTotalGoals: totals, modeledHalfFull: expectedHalfFullDistribution(grid, { firstHalfGoalShare: .45 }) },
  };
  if (malformed) malformed(report);
  const codeHashes = Object.fromEntries(["one", "two", "three", "four", "five"].map((key) => [key, "a".repeat(64)]));
  const engine = cloudCaptureEngine({ store, codeHashes, bundled, clock: () => clock,
    async fetchOfficial() { calls++; if (beforeSource) await beforeSource(); if (sourceError) throw sourceError instanceof Error?sourceError:new Error(sourceError); return { matches: emptySource ? [] : [match], fetchedAt: at, poolStatus: Object.fromEntries(["HAD", "HHAD", "CRS", "TTG", "HAFU"].map((pool) => [pool, { status: "success",observedAt:at }])) }; },
    async predict() { const prediction={ officialMatches: [match], reports: [report], officialSource: { method: "server-refetch", fetchedAt: at, manifestState: "complete", poolStatus: Object.fromEntries(["HAD", "HHAD", "CRS", "TTG", "HAFU"].map(pool => [pool, { status: "success",observedAt:at }])) }, version: { inputSnapshotId: "test-input" } };if(changePredictionSource)changePredictionSource(prediction.officialSource);return prediction; },
    async readResults() { return { results: [], fetchedAt: clock }; }, async readResultEvents() { return []; }, async appendResult() { throw new Error("unexpected result append"); },
  });
  return { engine, store, setClock(value) { clock = value; }, get calls() { return calls; }, codeHashes };
}
const job = (requestId = "test-run-1") => ({ action: "decisions", requestId });

test("verified zero fixtures is recorded separately from unknown manifest and failed source", async () => {
  const h = harness({ emptySource: true });
  const result = await h.engine.execute(job());
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "official-zero-fixtures");
  const universe = (await h.store.list("official-universe"))[0];
  assert.deepEqual(universe.payload.fixtures, []);
  assert.equal((await h.store.list("raw")).length, 0);
});

test("a real-store engine losing its lease stops audit/index/complete and cannot release its replacement", async () => {
  const sql = await researchDatabase(), bytes = new Map();
  const store = cloudResearchStore({ database: sqliteD1(sql), objects: {
    async put(key, value) { if (!bytes.has(key)) bytes.set(key, value); },
    async get(key) { return bytes.has(key) ? { text: async () => bytes.get(key) } : null; },
  } });
  let replacement;
  try {
    const h = harness({ storeOverride: store, sourceError: "source failed after ownership changed", async beforeSource() {
      sql.exec("UPDATE research_capture_leases SET lease_until = unixepoch() - 1");
      replacement = await store.claim({ id: "replacement-run", requestHash: "b".repeat(64), startedAt: "2026-10-02T04:51:00Z" });
    } });
    await assert.rejects(h.engine.execute(job()), { code: "CLOUD_LEASE_LOST" });
    assert.equal(sql.prepare("SELECT count(*) AS n FROM research_capture_records").get().n, 0);
    assert.equal((await store.getRun("test-run-1")).status, "running");
    await store.withLease(replacement.lease).assertLease();
  } finally { sql.close(); }
});

test("public writes require a configured job credential, independently of Site headers", () => {
  const token = "t".repeat(48);
  assert.equal(authorizedCloudCapture(new Request("https://test.invalid", { headers: { "OAI-Sites-Authorization": `Bearer ${token}`, "oai-authenticated-user-id": "anything" } }), token), false);
  assert.equal(authorizedCloudCapture(new Request("https://test.invalid", { headers: { authorization: `Bearer ${token}` } }), token), true);
  assert.equal(authorizedCloudCapture(new Request("https://test.invalid", { headers: { authorization: "Bearer wrong" } }), token), false);
  assert.equal(authorizedCloudCapture(new Request("https://test.invalid"), undefined), false);
});
test("trigger rejects caller supplied quotes, reports, times and past snapshot dates", () => {
  for (const extra of [{ reports: [] }, { odds: [1, 2, 3] }, { capturedAt: "2026-09-01T00:00:00Z" }, { date: "2026-09-01" }]) assert.throws(() => validateCloudCaptureJob({ ...job(), ...extra }));
  assert.throws(() => validateCloudCaptureJob({ action: "purchase", requestId: "test" }), /批次/);
});
test("real source failure is persisted with unknown universe and idempotent retry", async () => {
  const h = harness({ sourceError: "official response missing matchInfoList" });
  assert.equal((await h.engine.execute(job())).status, "failed");
  const attempt = h.store.records.get("attempt-test-run-1-1").payload;
  assert.equal(attempt.officialManifest, null); assert.equal(attempt.stage, "official-source");
  assert.equal((await h.engine.execute(job())).status, "failed"); assert.equal(h.calls, 1);
  assert.equal((await h.store.list("raw")).length, 0);
});

test("cloud attempts preserve structured unknown-manifest failures without saved forecasts",async()=>{
 const sourceState={manifestState:"unknown",poolStatus:{HAD:{status:"failed",matchCount:null,issues:[{source:"primary",kind:"manifest-unavailable"}]}}};
 const h=harness({sourceError:Object.assign(new Error("configuration only"),{code:"OFFICIAL_MANIFEST_UNAVAILABLE",sourceState})});
 assert.equal((await h.engine.execute(job())).status,"failed");
 const attempt=(await h.store.list("source-attempt"))[0].payload;
 assert.equal(attempt.sourceCode,"OFFICIAL_MANIFEST_UNAVAILABLE");assert.deepEqual(attempt.sourceState,sourceState);assert.equal(attempt.officialManifest,null);
 assert.equal((await h.store.list("raw")).length,0);
});

test("a complete initial list cannot bless a later partial official prediction reread",async()=>{
 const h=harness({changePredictionSource:source=>{source.manifestState="partial";source.poolStatus.CRS.status="failed";}});
 const result=await h.engine.execute(job());assert.equal(result.status,"failed");assert.match(result.reason,/完整五玩法/);
 assert.equal((await h.store.list("raw")).length,0);assert.equal((await h.store.list("purchase")).length,0);
});
test("only actual pre-target window can append complete raw and verified persistence receipt", async () => {
  const h = harness(), result = await h.engine.execute(job());
  assert.equal(result.status, "saved");
  const raw = (await h.store.list("raw"))[0].payload;
  assert.equal(raw.scheduledTime, "1300"); assert.equal(raw.captureTiming, "pending-readback");
  assert.equal(raw.reports[0].fullScoreDistribution.length, 169);
  const receipt = h.store.records.get(`raw-receipt-${raw.snapshotId}`).payload;
  assert.equal(receipt.includedInStrictEvaluation, true); assert.equal(receipt.rawHash, researchHash(raw));
  await h.engine.execute(job("test-run-2")); assert.equal((await h.store.list("raw")).length, 1);
});
test("outside or missed target is never backfilled by a later dispatcher", async () => {
  for (const at of ["2026-10-02T12:40:00+08:00", "2026-10-02T13:01:00+08:00"]) {
    const h = harness({ at }); assert.equal((await h.engine.execute(job())).reason, "no-due-fixtures");
    assert.equal((await h.store.list("raw")).length, 0);
  }
});
test("readback crossing target retains evidence but is delayed and excluded from strict validation", async () => {
  const h = harness({ duringWrite: "2026-10-02T13:00:01+08:00" });
  const result = await h.engine.execute(job()); assert.equal(result.records[0].timing, "delayed-batch");
  const receipt = (await h.store.list("receipt"))[0].payload;
  assert.equal(receipt.includedInStrictEvaluation, false); assert.equal(receipt.persistedAt, "2026-10-02T13:00:01+08:00");
});
test("malformed fusion grid or normalized market vectors cannot become raw evidence", async () => {
  for (const malformed of [r => { r.fullScoreDistribution = r.fullScoreDistribution.map(p => ({ ...p, score: "0:0" })); }, r => { r.marketSignal.modeledTotalGoals[0] = -1; }, r => { r.marketSignal.modeledHalfFull[0] = NaN; }, r => { r.marketSignal.modeledTotalGoals = Array(8).fill(12.5); }, r => { r.marketSignal.modeledHalfFull = Array(9).fill(100 / 9); }]) {
    const h = harness({ malformed }); assert.equal((await h.engine.execute(job())).status, "failed");
    assert.equal((await h.store.list("raw")).length, 0);
  }
});
test("late fixed-ticket invocation logs an actual skip without reading or manufacturing data", async () => {
  const h = harness({ at: "2026-10-02T23:00:00+08:00" });
  const result = await h.engine.execute({ action: "purchase", slot: "2100", requestId: "late-purchase" });
  assert.equal(result.reason, "window-closed"); assert.equal(h.calls, 0);
  assert.equal((await h.store.list("purchase")).length, 0);
});

test("same-column HAFU shifts and mismatched actual share cannot become evidence", async () => {
  for (const malformed of [r => { r.marketSignal.modeledHalfFull[0] += .1; r.marketSignal.modeledHalfFull[3] -= .1; },
    r => { r.modelParameters.firstHalfGoalShare = .53; }, r => { r.modelParameters.firstHalfGoalShare = NaN; }]) {
    const h = harness({ malformed });
    assert.equal((await h.engine.execute(job())).status, "failed");
    assert.equal((await h.store.list("raw")).length, 0);
  }
});
test("missing official days suspend forward eligibility without inventing a denominator", async () => {
  const base = harness();
  const manifest = freezeForwardManifest({ startAt: "2026-10-01T16:00:00.000Z", endAt: "2026-11-01T16:00:00.000Z", codeHashes: base.codeHashes, teamWeight: .25 }, "2026-10-01T12:00:00.000Z");
  const h = harness({ at: "2026-10-03T12:00:00+08:00", bundled: { manifest } });
  await h.engine.execute({ action: "replay", requestId: "test-replay" });
  const evaluation = (await h.store.list("replay-index"))[0].payload.evaluation;
  assert.equal(evaluation.eligible, false); assert.equal(evaluation.status, "official-coverage-unknown");
  assert.ok(evaluation.missingSourceDates.includes("2026-10-02")); assert.equal(evaluation.officialCoverageKnown, false);
});
