import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import {
  asianSettlement,
  asianNetReturn,
  splitAsianLine,
  priceAsianDistribution,
  deVig,
} from "../app/asian-market.js";
import {
  normalizeCompany,
  assessPredictionInput,
  createOddsBatchLoader,
} from "../app/prediction-input.js";
import {
  predictFromSnapshot,
  projectScoreMarkets,
  temperatureCalibrate,
  calibrateScoreDistribution,
  compatibleCalibration,
  PREDICTION_PIPELINE_VERSION,
  CALIBRATION_STAGE,
} from "../app/prediction-model.js";
import {
  replayTotalGoals,
  summarizeTotalGoals,
  compareTotalGoalTickets,
} from "../app/total-goals-evaluation.js";

// Synthetic fixtures remain in memory only; never written to prediction history.
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const at = "2026-09-29T09:00:00.000Z",
  odds = [16, 8, 3.2, 4, 8, 16, 32, 32];
const company = (id) =>
  normalizeCompany(
    {
      SOURCE_COMPANY_ID: id,
      WIN: 2,
      SAME: 3.5,
      LOST: 4,
      HANDICAP: -0.25,
      HOST: 0.9,
      GUEST: 0.9,
      DW_HANDICAP: 2.5,
      BIG: 0.9,
      SMALL: 0.9,
    },
    at,
  );
const input = () => ({
  schemaVersion: 1,
  pipelineVersion: PREDICTION_PIPELINE_VERSION,
  decisionAt: at,
  companies: [company(2), company(3)],
  official: {
    officialMatchId: "test-1",
    salesDate: "2026-09-29",
    kickoffAt: "2026-09-29T14:00:00Z",
    fetchedAt: at,
    hadOdds: [2, 3.5, 4],
    handicap: -1,
    hhadOdds: [4, 3.4, 1.8],
    totalOdds: odds,
  },
});

test("Asian exact stake settlement handles pushes, quarter wins/losses and floating line tolerance", () => {
  assert.deepEqual(splitAsianLine(-0.75), [-1, -0.5]);
  for (const [value, line, kind, net] of [
    [0, 0, "handicap", 0],
    [0, -0.5, "handicap", -1],
    [0, -0.25, "handicap", -0.5],
    [0, 0.25, "handicap", 0.45],
    [1, -0.75, "handicap", 0.45],
    [2, 2.25, "total", -0.5],
    [3, 2.75, "total", 0.45],
  ])
    near(asianNetReturn(value, line, 0.9, kind), net);
  assert.deepEqual(asianSettlement(1, -1.0000000001), { win: 0, push: 1, loss: 0 });
  for (const line of [null, "", NaN, 2.1]) assert.throws(() => splitAsianLine(line));
  const quarter = priceAsianDistribution(
    [
      { value: 2, probability: 0.6 },
      { value: 3, probability: 0.4 },
    ],
    2.25,
    "total",
  );
  near(quarter.win, 0.4);
  near(quarter.loss, 0.3);
  near(quarter.push, 0.3);
  near(quarter.riskProbability, 4 / 7);
  near(quarter.fairNetOdds, 0.75);
  const push = priceAsianDistribution(
    [
      [-1, 0.2],
      [0, 0.5],
      [1, 0.3],
    ].map(([value, probability]) => ({ value, probability })),
    0,
  );
  near(push.riskProbability, 0.6);
});

test("missing/invalid input is not zero, equal probability or an extra company", () => {
  const missing = normalizeCompany(
    { SOURCE_COMPANY_ID: 3, WIN: 2, SAME: 3, LOST: 4, HANDICAP: "", HOST: 0.9, GUEST: 0.9 },
    at,
  );
  assert.equal(missing.handicap, null);
  assert.equal(missing.total, null);
  assert.equal(
    assessPredictionInput([missing, { ...missing, companyId: 2 }], at).status,
    "unavailable",
  );
  assert.equal(assessPredictionInput([company(2), company(undefined)], at).status, "unavailable");
  assert.equal(
    assessPredictionInput([company(2), company(2), company(3)], at).status,
    "unavailable",
  );
  assert.equal(
    assessPredictionInput([company(2), company(3)], "2026-09-29T09:06:00Z").status,
    "unavailable",
  );
  assert.equal(deVig([2, 3, null], 3), null);
  assert.throws(() => predictFromSnapshot({ ...input(), companies: [missing] }));
});

test("issue caches retain individual timestamps, coalesce requests and isolate failures", async () => {
  let now = Date.parse(at),
    calls = 0;
  const load = createOddsBatchLoader(
    async (issue) => {
      calls++;
      if (issue === "bad") throw Error("source failure");
      return [issue];
    },
    { clock: () => now },
  );
  const [first, second] = await Promise.all([load("A"), load("A")]);
  assert.equal(calls, 1);
  assert.equal(first, second);
  now += 1000;
  const b = await load("B");
  assert.notEqual(b.fetchedAt, first.fetchedAt);
  assert.equal((await load("A")).fetchedAt, first.fetchedAt);
  const results = await Promise.allSettled([load("A"), load("bad")]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  now += 1000;
  assert.notEqual((await load("A", true)).fetchedAt, first.fetchedAt);
});

test("live/replay core is deterministic and all market marginals share final calibrated score mass", () => {
  const snapshot = input(),
    base = predictFromSnapshot(snapshot),
    replayed = predictFromSnapshot(structuredClone(snapshot));
  assert.deepEqual(base, replayed);
  assert.deepEqual(
    base.fullScoreDistribution,
    predictFromSnapshot({ ...snapshot, companies: [...snapshot.companies].reverse() })
      .fullScoreDistribution,
  );
  const calibrated = predictFromSnapshot(snapshot, { temperature: 2 }),
    markets = projectScoreMarkets(calibrated.fullScoreDistribution, -1),
    rawHad = projectScoreMarkets(base.fullScoreDistribution).had;
  const offline = temperatureCalibrate(rawHad, 2);
  markets.had.forEach((p, i) => near(p, offline[i]));
  for (const probs of [
    calibrated.fullScoreDistribution.map((p) => p.probability),
    calibrated.totalGoalProbabilities,
    calibrated.hhadProbabilities,
    calibrated.halfFullProbabilities,
  ])
    near(
      probs.reduce((a, b) => a + b, 0),
      100,
    );
  markets.had.forEach((p, i) =>
    near(
      p * 100,
      [0, 1, 2].reduce((sum, half) => sum + calibrated.halfFullProbabilities[half * 3 + i], 0),
    ),
  );
  const means = [0, 0];
  calibrated.fullScoreDistribution.forEach((p) =>
    p.score
      .split(":")
      .map(Number)
      .forEach((g, i) => (means[i] += (g * p.probability) / 100)),
  );
  means.forEach((m, i) => near(m, calibrated.expectedGoals[i]));
  const q = calibrated.priceDiagnostics[0],
    priced = priceAsianDistribution(
      calibrated.fullScoreDistribution.map((p) => {
        const [h, a] = p.score.split(":").map(Number);
        return { value: h - a, probability: p.probability / 100 };
      }),
      q.line,
    );
  near(priced.riskProbability, q.modeledRiskProbability);
  assert.throws(() =>
    calibrateScoreDistribution(
      [
        { score: "1:0", probability: 60 },
        { score: "0:1", probability: 40 },
      ],
      2,
    ),
  );
});

test("old or unrelated calibration profiles cannot activate the new pipeline", () => {
  assert.equal(compatibleCalibration({ status: "validated" }), false);
  const profile = {
    schemaVersion: 1,
    status: "validated",
    baseModelVersion: PREDICTION_PIPELINE_VERSION,
    fusionModelVersion: "evidence-and-out-of-sample-gated-v3",
    calibrationStage: CALIBRATION_STAGE,
    evaluationMode: "raw-input-replay",
    promotionGates: [{ passed: true }],
  };
  assert.equal(compatibleCalibration(profile), true);
  for (const patch of [
    { baseModelVersion: "old" },
    { calibrationStage: "before-fit" },
    { evaluationMode: "legacy-probability-diagnostic" },
    { promotionGates: [{ passed: false }] },
  ])
    assert.equal(compatibleCalibration({ ...profile, ...patch }), false);
});

test("total goals market comparison uses complete contemporaneous inputs and identical tickets", () => {
  const record = {
    snapshotId: "test-snapshot",
    capturedAt: at,
    modelInput: input(),
    actualTotalGoals: 2,
  };
  const row = replayTotalGoals(record);
  assert.equal(row.status, "ready");
  assert.deepEqual(row.marketTopTwo, [2, 3]);
  near(row.market[2] + row.market[3], 0.5625);
  const same = { ...row, model: row.market },
    second = { ...same, key: "test-2|2026-09-29", actual: 3 };
  const ticket = compareTotalGoalTickets([same, second]);
  near(ticket.market.stake, 8);
  near(ticket.market.returned, 25.6);
  near(ticket.market.netProfit, 17.6);
  near(ticket.market.estimatedHitProbability, 0.31640625);
  assert.deepEqual(ticket.model, ticket.market);
  assert.throws(() => compareTotalGoalTickets([same, same]));
  assert.throws(() => compareTotalGoalTickets([same, { ...second, snapshotId: "other" }]));
  const missing = structuredClone(record);
  missing.modelInput.official.totalOdds.pop();
  assert.equal(replayTotalGoals(missing).status, "unavailable");
  const late = structuredClone(record);
  late.modelInput.official.fetchedAt = "2026-09-29T09:01:00Z";
  assert.equal(replayTotalGoals(late).status, "unavailable");
  const after = structuredClone(record);
  after.capturedAt = "2026-09-29T14:01:00Z";
  assert.equal(replayTotalGoals(after).status, "unavailable");
  assert.equal(replayTotalGoals({ ...record, actualTotalGoals: 8 }).actual, 7);
  const summary = summarizeTotalGoals([record, record, { snapshotId: "legacy" }]);
  assert.equal(summary.comparableMatches, 1);
  assert.equal(summary.duplicatesExcluded, 1);
  assert.equal(summary.promotionEligible, false);
});

test("calibration pairs half/full samples and test results cannot choose runtime parameters", async () => {
  const source = (await readFile(new URL("../app/calibration-service.ts", import.meta.url), "utf8"))
    .replace(
      /from "(\.\/(?:prediction-model|snapshot-decision-policy|probability-evaluation)\.js)"/g,
      (_, p) => `from ${JSON.stringify(new URL(p.replace("./", "../app/"), import.meta.url).href)}`,
    )
    .replace(/import\.meta\.glob<ModelCalibrationProfile>\([^;]+\);/, "{};");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { buildCalibrationEvaluation } = await import(
    `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
  );
  const points = [
    { score: "胜", probability: 60 },
    { score: "平", probability: 25 },
    { score: "负", probability: 15 },
  ];
  const rows = Array.from({ length: 100 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    return {
      matchKey: `test-${i}`,
      league: "测试",
      kickoffAt: `${date}T20:00:00+08:00`,
      capturedAt: `${date}T19:30:00+08:00`,
      modelProbabilities: points,
      baseModelProbabilities: points,
      intelligenceCandidateProbabilities: [
        { score: "胜", probability: 90 },
        { score: "平", probability: 5 },
        { score: "负", probability: 5 },
      ],
      marketProbabilities: points,
      actual: "胜",
      totalGoals: 2,
      halfGoals: i % 2 ? undefined : 1,
      intelligenceCoverage: 100,
    };
  });
  const before = buildCalibrationEvaluation(rows),
    after = buildCalibrationEvaluation(
      rows.map((row, i) => (i < 80 ? row : { ...row, actual: "负", halfGoals: 0, totalGoals: 4 })),
    );
  near(before.global.firstHalfGoalShare, 0.5);
  assert.equal(before.global.halfTimePairedSampleSize, 30);
  assert.deepEqual(before.global, after.global);
  assert.deepEqual(before.leagues, after.leagues);
  assert.equal(before.probabilityTemperature, after.probabilityTemperature);
  assert.equal(before.intelligenceWeightMultiplier, 0);
  assert.equal(after.intelligenceWeightMultiplier, 0);
  assert.equal(before.profileId, after.profileId);
  assert.equal(before.promotionGates.find((g) => g.key === "raw-replay").passed, false);
});
