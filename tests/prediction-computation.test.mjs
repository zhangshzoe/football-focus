import test from "node:test";
import assert from "node:assert/strict";
import { computePredictionUnit } from "../app/prediction-computation.js";
import { PREDICTION_PIPELINE_VERSION, predictFromSnapshot } from "../app/prediction-model.js";
import { fitTeamStrength } from "../app/team-strength-model.js";
import { createPredictionComputeCache } from "../app/prediction-compute-cache.js";

// Synthetic fixture data stays in test memory, never production snapshots.
function unit() {
  const decisionAt = "2026-10-02T08:00:00.000Z";
  return {
    schemaVersion: 1,
    namespace: "official",
    calibrationId: "cal-none",
    modelInput: {
      schemaVersion: 1,
      pipelineVersion: PREDICTION_PIPELINE_VERSION,
      decisionAt,
      companies: [2, 3].map((companyId) => ({
        companyId,
        fetchedAt: decisionAt,
        win: 2,
        draw: 3.2,
        lose: 3.8,
        handicap: -0.25,
        homePrice: 0.9,
        awayPrice: 0.95,
        total: 2.5,
        overPrice: 0.9,
        underPrice: 0.95,
        missingFields: [],
        invalidFields: [],
      })),
      official: {
        officialMatchId: "fixture-123",
        salesDate: "2026-10-02",
        kickoffAt: "2026-10-02T20:00:00Z",
        fetchedAt: decisionAt,
        hadOdds: [2, 3.2, 3.8],
        handicap: -1,
        hhadOdds: [4, 3.6, 1.8],
        totalOdds: [16, 8, 4, 3, 5, 10, 20, 30],
      },
      teamHistory: { rows: [] },
    },
    modelParameters: { temperature: 1 },
    teamOptions: {
      league: "test",
      homeTeamId: "uniform-home",
      awayTeamId: "uniform-away",
      decisionAt,
    },
  };
}

test("serializable unit computes both existing paths without changing replay values", () => {
  const frozen = unit(),
    before = structuredClone(frozen);
  const result = computePredictionUnit(JSON.parse(JSON.stringify(frozen)));
  assert.deepEqual(
    result.marketModel,
    predictFromSnapshot(frozen.modelInput, frozen.modelParameters),
  );
  assert.deepEqual(result.teamStrengthCandidate, fitTeamStrength([], frozen.teamOptions));
  assert.deepEqual(frozen, before);
  assert.equal(result.teamStrengthCandidate.status, "insufficient-data");
  assert.equal("predictionGeneratedAt" in result, false);
  assert.equal("contextProof" in result, false);
  assert.equal("marketEligibility" in result, false);
});

test("market cache reuse never skips independent frozen-history team calculation", () => {
  const calls = [],
    frozen = unit();
  const cache = createPredictionComputeCache({ compute: () => ({ result: "market" }) });
  const deps = {
    marketCompute: cache.predict,
    teamCompute: (rows, options) => {
      calls.push({ rows: structuredClone(rows), options: structuredClone(options) });
      return { sampleSize: rows.length };
    },
  };
  computePredictionUnit(frozen, deps);
  frozen.modelInput.teamHistory.rows.push({ fixtureId: "history-1" });
  computePredictionUnit(frozen, deps);
  assert.deepEqual(cache.stats(), { hits: 1, misses: 1, entries: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].rows[0].fixtureId, "history-1");
  assert.equal(calls[1].options.homeTeamId, "uniform-home");
});

test("research namespace remains isolated and cannot gain official or team eligibility", () => {
  const frozen = unit();
  frozen.namespace = "research";
  frozen.scope = "2026-10-02:external-123";
  frozen.modelInput.official = {};
  delete frozen.teamOptions;
  const result = computePredictionUnit(frozen);
  assert.equal(result.teamStrengthCandidate, null);
  assert.deepEqual(
    result.marketModel,
    predictFromSnapshot(frozen.modelInput, frozen.modelParameters),
  );
  assert.throws(() => computePredictionUnit({ ...frozen, scope: "" }), /Research/);
  frozen.modelInput.official.officialMatchId = "illegal";
  assert.throws(() => computePredictionUnit(frozen), /Research/);
});

test("unsupported identities, detached history times and asynchronous fit never pass", () => {
  for (const change of [
    (u) => (u.schemaVersion = 2),
    (u) => (u.namespace = "unknown"),
    (u) => (u.modelInput.pipelineVersion = "old"),
    (u) => (u.modelInput.official.officialMatchId = ""),
    (u) => (u.teamOptions.decisionAt = "2026-10-03T00:00:00Z"),
    (u) => delete u.modelInput.teamHistory,
  ]) {
    const frozen = unit();
    change(frozen);
    let calls = 0;
    assert.throws(() =>
      computePredictionUnit(frozen, {
        marketCompute: () => {
          calls += 1;
          return {};
        },
      }),
    );
    assert.equal(calls, 0);
  }
  assert.throws(
    () => computePredictionUnit(unit(), { marketCompute: () => Promise.resolve({}) }),
    /synchronously/,
  );
  assert.throws(
    () =>
      computePredictionUnit(unit(), {
        marketCompute: () => ({}),
        teamCompute: () => Promise.resolve({}),
      }),
    /synchronously/,
  );
});
