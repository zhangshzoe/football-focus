import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import {
  buildSnapshotOddsLayer,
  snapshotOddsProjection,
  projectSnapshotOddsLayers,
  snapshotFrozenOfficialHad,
} from "../app/snapshot-probability-layers.js";

const grid = (masses = { "1:0": 55, "0:0": 25, "0:1": 20 }) =>
  Array.from({ length: 169 }, (_, index) => {
    const score = `${Math.floor(index / 13)}:${index % 13}`;
    return { score, probability: masses[score] || 0 };
  });
const frozen = (value) => {
  Object.freeze(value);
  for (const item of Object.values(value))
    if (item && typeof item === "object" && !Object.isFrozen(item)) frozen(item);
  return value;
};

test("new odds layers preserve fitting targets separately from their exact score marginals", () => {
  const layer = buildSnapshotOddsLayer({
    fullScoreDistribution: grid(),
    marketProbabilities: [40, 30, 30],
  });
  assert.deepEqual(layer.probabilities, { home: 55, draw: 25, away: 20 });
  assert.deepEqual(
    layer.marketFitTargetHadProbabilities.map((p) => p.probability),
    [40, 30, 30],
  );
  assert.equal(layer.fullScoreDistribution.length, 169);
  assert.equal(layer.probabilityUnit, "percent");
});

test("raw and compact legacy projections are immutable and idempotent, without modifying fusion", () => {
  const raw = frozen({
    predictionId: "unchanged",
    layers: {
      oddsBaseline: {
        fullScoreDistribution: grid(),
        probabilities: { home: 40, draw: 30, away: 30 },
      },
      fusionOutput: { fullScoreDistribution: grid({ "1:0": 20, "0:0": 20, "0:1": 60 }) },
    },
  });
  const before = JSON.stringify(raw),
    projected = snapshotOddsProjection(raw);
  assert.deepEqual(
    projected.oddsHadProbabilities.map((p) => p.probability),
    [55, 25, 20],
  );
  assert.deepEqual(
    projected.marketFitTargetHadProbabilities.map((p) => p.probability),
    [40, 30, 30],
  );
  assert.equal(projected.marketFitTargetBasis, "legacy-unverified-target");
  assert.deepEqual(snapshotOddsProjection(projected), projected);
  assert.equal(JSON.stringify(raw), before);
  const snapshot = frozen({
    snapshotId: "legacy",
    matches: [
      {
        ...raw,
        oddsScores: grid(),
        marketHadProbabilities: [
          { score: "胜", probability: 40 },
          { score: "平", probability: 30 },
          { score: "负", probability: 30 },
        ],
      },
    ],
  });
  const result = projectSnapshotOddsLayers(snapshot);
  assert.deepEqual(result.matches[0].marketHadProbabilities, projected.oddsHadProbabilities);
  assert.deepEqual(result.matches[0].layers.fusionOutput, raw.layers.fusionOutput);
  assert.deepEqual(projectSnapshotOddsLayers(result), result);
});

test("an incomplete odds grid cannot borrow the complete fusion grid or promote old target probabilities", () => {
  const value = snapshotOddsProjection({
    oddsScores: grid().slice(0, 4),
    fullScoreDistribution: grid(),
    marketProbabilities: [40, 30, 30],
  });
  assert.deepEqual(value.oddsHadProbabilities, []);
  assert.deepEqual(value.marketHadProbabilities, []);
  assert.equal(value.marketHadProbabilityBasis, "unavailable-incomplete-odds-grid");
  assert.deepEqual(
    value.marketFitTargetHadProbabilities.map((p) => p.probability),
    [40, 30, 30],
  );
  assert.throws(
    () => buildSnapshotOddsLayer({ oddsScores: grid().slice(0, 4), fullScoreDistribution: grid() }),
    /完整169/,
  );
});

for (const [label, mutate] of [
  ["missing cell", (rows) => rows.slice(1)],
  ["duplicate cell", (rows) => rows.map((p, i) => (i === 1 ? rows[0] : p))],
  ["out-of-range cell", (rows) => rows.map((p, i) => (i === 0 ? { ...p, score: "13:0" } : p))],
  ["negative probability", (rows) => rows.map((p, i) => (i === 0 ? { ...p, probability: -1 } : p))],
  [
    "nonfinite probability",
    (rows) => rows.map((p, i) => (i === 0 ? { ...p, probability: NaN } : p)),
  ],
  ["wrong mass", (rows) => rows.map((p) => ({ ...p, probability: p.probability / 100 }))],
])
  test(`invalid odds grid stays unavailable: ${label}`, () => {
    assert.deepEqual(
      snapshotOddsProjection({ oddsScores: mutate(grid()) }).oddsHadProbabilities,
      [],
    );
  });

test("official benchmark comes from verified frozen odds, never from a fitting target or marginal", () => {
  const match = {
    officialMatchId: "123",
    salesDate: "2026-10-02",
    kickoffAt: "2026-10-02T23:00:00+08:00",
    marketHadProbabilities: [{ score: "胜", probability: 99 }],
    modelInput: {
      decisionAt: "2026-10-02T16:50:00+08:00",
      official: {
        officialMatchId: "123",
        salesDate: "2026-10-02",
        kickoffAt: "2026-10-02T23:00:00+08:00",
        fetchedAt: "2026-10-02T16:49:00+08:00",
        hadOdds: [2, 4, 4],
      },
    },
  };
  assert.deepEqual(
    snapshotFrozenOfficialHad(match).map((p) => p.probability),
    [50, 25, 25],
  );
  assert.deepEqual(snapshotFrozenOfficialHad({ ...match, officialMatchId: "456" }), []);
  assert.deepEqual(
    snapshotFrozenOfficialHad({
      ...match,
      modelInput: {
        ...match.modelInput,
        official: { ...match.modelInput.official, fetchedAt: "2026-10-02T16:51:00+08:00" },
      },
    }),
    [],
  );
  assert.deepEqual(snapshotFrozenOfficialHad({ ...match, modelInput: undefined }), []);
});

test("disk, bundled, migrated, purchase forecasts and evaluation paths use the shared probability projection", async () => {
  const api = await readFile(
    new URL("../app/api/prediction-snapshots/route.ts", import.meta.url),
    "utf8",
  );
  const sync = await readFile(
    new URL("../scripts/sync-prediction-decision-index.mjs", import.meta.url),
    "utf8",
  );
  const audit = await readFile(
    new URL("../scripts/audit-prediction-history.mjs", import.meta.url),
    "utf8",
  );
  assert.match(api, /\.\.\.snapshotOddsProjection\(report\)/);
  assert.match(api, /snapshots\.map\(projectSnapshotOddsLayers\)/);
  assert.match(api, /mergedEvaluationSnapshots=.*\.map\(projectSnapshotOddsLayers\)/);
  assert.match(api, /evaluationSnapshots=mergedEvaluationSnapshots\.filter/);
  assert.match(api, /reports:record\.forecasts/);
  assert.match(sync, /migration\.snapshots\.map\(projectSnapshotOddsLayers\)/);
  assert.match(sync, /data\.evaluationSnapshots.*\.map\(projectSnapshotOddsLayers\)/);
  assert.match(audit, /marketHad: points\(snapshotFrozenOfficialHad\(match\)\)/);
  assert.doesNotMatch(audit, /marketHad: points\(match\.marketHadProbabilities\)/);
});

const panel = await readFile(
  new URL("../app/components/ForwardValidationPanel.tsx", import.meta.url),
  "utf8",
);
const javascript = ts
  .transpileModule(panel, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  })
  .outputText.replaceAll('from "react"', `from ${JSON.stringify(import.meta.resolve("react"))}`)
  .replaceAll(
    'from "react/jsx-runtime"',
    `from ${JSON.stringify(import.meta.resolve("react/jsx-runtime"))}`,
  );
const { decodeForwardValidation } = await import(
  `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
);

test("research display rejects malformed payloads instead of presenting a false not-frozen or passed result", () => {
  for (const payload of [
    null,
    [],
    {},
    { manifest: null },
    { manifest: null, evaluation: [] },
    { manifest: {}, evaluation: { status: "evaluated", eligible: true } },
  ])
    assert.throws(() => decodeForwardValidation(payload));
  const value = decodeForwardValidation({
    manifest: null,
    evaluation: { status: "not-frozen", eligible: true, sampleSize: 0 },
    resultEventCount: 0,
    unsyncedResultEvents: 0,
  });
  assert.equal(value.evaluation.eligible, false);
  assert.equal(value.evaluation.sampleSize, 0);
});

test("research display retains official baseline and paired uncertainty, with no promotion while collecting", () => {
  const manifest = {
    manifestId: "test",
    frozenAt: "2026-10-01T00:00:00Z",
    startAt: "2026-10-02T00:00:00Z",
    endAt: "2026-12-01T00:00:00Z",
    teamWeight: 0.25,
    gates: { minimumPairedFixtures: 100 },
  };
  const payload = {
    manifest,
    evaluation: {
      status: "collecting",
      eligible: true,
      sampleSize: 20,
      market: { sampleSize: 20, brier: 0.6, logLoss: 0.9, ece: 0.1 },
      oddsInterval: { delta: -0.01, lower: -0.02, upper: 0.01 },
      gates: [{ key: "window", label: "验证期", passed: true }],
    },
  };
  const value = decodeForwardValidation(payload);
  assert.equal(value.evaluation.eligible, false);
  assert.equal(value.evaluation.market.brier, 0.6);
  assert.deepEqual(value.evaluation.oddsInterval, { delta: -0.01, lower: -0.02, upper: 0.01 });
  assert.throws(
    () =>
      decodeForwardValidation({ ...payload, manifest: { ...manifest, frozenAt: manifest.endAt } }),
    /元数据无效/,
  );
  assert.throws(
    () =>
      decodeForwardValidation({
        ...payload,
        evaluation: {
          ...payload.evaluation,
          gates: [{ key: "window", label: "验证期", passed: "true" }],
        },
      }),
    /门槛记录无效/,
  );
  assert.match(panel, /冻结官方赔率去水基线/);
  assert.match(panel, /北京时间区间/);
  assert.match(panel, /95%日期区块重采样区间/);
  assert.doesNotMatch(panel, /\bany\b/);
});
