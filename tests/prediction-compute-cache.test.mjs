import test from "node:test";
import assert from "node:assert/strict";
import { createPredictionComputeCache } from "../app/prediction-compute-cache.js";
import { PREDICTION_PIPELINE_VERSION, predictFromSnapshot } from "../app/prediction-model.js";

// Synthetic inputs remain in memory and never enter actual research storage.
const at = Date.parse("2026-10-02T08:00:00Z");
function input() {
  return {
    schemaVersion: 1,
    pipelineVersion: PREDICTION_PIPELINE_VERSION,
    decisionAt: new Date(at).toISOString(),
    companies: [2, 3].map((companyId) => ({
      companyId,
      fetchedAt: new Date(at).toISOString(),
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
      officialMatchId: "123",
      salesDate: "2026-10-02",
      kickoffAt: "2026-10-02T20:00:00Z",
      fetchedAt: new Date(at).toISOString(),
      hadOdds: [2, 3.2, 3.8],
      handicap: -1,
      hhadOdds: [4, 3.6, 1.8],
      totalOdds: [16, 8, 4, 3, 5, 10, 20, 30],
    },
  };
}
const options = { mode: "official", calibrationId: "test-profile" };

test("unchanged numerical inputs reuse pure output, not observation proof or caller objects", () => {
  let calls = 0;
  const cache = createPredictionComputeCache({
    compute: () => ({ probabilities: [++calls, 2] }),
    clock: () => at,
  });
  const first = input(),
    result = cache.predict(first, {}, options);
  result.probabilities[0] = 99;
  const second = input();
  second.decisionAt = new Date(at + 1000).toISOString();
  second.official.fetchedAt = second.decisionAt;
  second.companies.forEach((row) => (row.fetchedAt = second.decisionAt));
  second.matchContext = { changed: true };
  second.teamHistory = { changed: true };
  assert.deepEqual(cache.predict(second, {}, options), { probabilities: [1, 2] });
  assert.equal(first.official.fetchedAt, new Date(at).toISOString());
  assert.equal(second.official.fetchedAt, second.decisionAt);
  assert.deepEqual(cache.stats(), { hits: 1, misses: 1, entries: 1 });
});

test("quote, identity, calibration, parameter and namespace changes cannot reuse another calculation", () => {
  let calls = 0;
  const cache = createPredictionComputeCache({
    compute: () => ({ sequence: ++calls }),
    clock: () => at,
  });
  cache.predict(input(), {}, options);
  for (const change of [
    (x) => (x.companies[0].homePrice += 0.01),
    (x) => (x.companies[0].handicap = -0.75),
    (x) => (x.companies[0].firstWin = 2.2),
    (x) => (x.official.totalOdds[7] = 31),
    (x) => (x.official.hhadOdds[0] = 4.2),
    (x) => (x.official.handicap = 1),
    (x) => (x.official.officialMatchId = "456"),
    (x) => x.companies[0].missingFields.push("firstTotal"),
  ]) {
    const changed = input();
    change(changed);
    cache.predict(changed, {}, options);
  }
  cache.predict(input(), { temperature: 1.1 }, options);
  cache.predict(input(), {}, { ...options, calibrationId: "other-profile" });
  cache.predict(input(), {}, { mode: "research", scope: "external-123" });
  assert.equal(calls, 12);
  assert.equal(cache.stats().hits, 0);
});

test("warm cache still rejects missing, future and stale official times and stale company times", () => {
  let calls = 0;
  const cache = createPredictionComputeCache({
    compute: () => ({ sequence: ++calls }),
    clock: () => at,
  });
  cache.predict(input(), {}, options);
  for (const stamp of [
    undefined,
    "bad",
    new Date(at + 1).toISOString(),
    new Date(at - 300001).toISOString(),
  ]) {
    const changed = input();
    changed.official.fetchedAt = stamp;
    assert.throws(() => cache.predict(changed, {}, options), /官方赔率/);
  }
  const changed = input();
  changed.companies[0].fetchedAt = new Date(at - 300001).toISOString();
  assert.throws(() => cache.predict(changed, {}, options), /过期/);
  assert.equal(calls, 1);
});

test("expiry does not slide, LRU is bounded, failures never become cached successes", () => {
  let now = at,
    calls = 0,
    fail = false;
  const cache = createPredictionComputeCache({
    maxEntries: 2,
    ttlMs: 100,
    clock: () => now,
    compute: () => {
      calls += 1;
      if (fail) throw new Error("failed compute");
      return { sequence: calls };
    },
  });
  cache.predict(input(), {}, options);
  now += 50;
  cache.predict(input(), {}, options);
  now += 50;
  cache.predict(input(), {}, options);
  assert.equal(calls, 2);
  cache.predict(input(), { temperature: 1.1 }, options);
  cache.predict(input(), { temperature: 1.2 }, options);
  assert.equal(cache.stats().entries, 2);
  cache.predict(input(), {}, options);
  assert.equal(calls, 5);
  fail = true;
  assert.throws(() => cache.predict(input(), { temperature: 1.3 }, options), /failed compute/);
  fail = false;
  cache.predict(input(), { temperature: 1.3 }, options);
  assert.equal(calls, 7);
});

test("cached actual model equals replay for every score and market after a fresh time-only change", () => {
  const cache = createPredictionComputeCache({ clock: () => at }),
    first = input(),
    parameters = { temperature: 1.2 };
  const expected = predictFromSnapshot(first, parameters);
  assert.deepEqual(cache.predict(first, parameters, options), expected);
  const second = input();
  second.decisionAt = new Date(at + 1000).toISOString();
  second.official.fetchedAt = second.decisionAt;
  second.companies.forEach((row) => (row.fetchedAt = second.decisionAt));
  assert.deepEqual(
    cache.predict(second, parameters, options),
    predictFromSnapshot(second, parameters),
  );
  assert.equal(cache.stats().hits, 1);
});
