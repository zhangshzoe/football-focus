import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// External draft: set FOOTBALL_FOCUS_TEST_ROOT to the checkout before running.
// Copied to tests/forward-validation.test.mjs, the default relative root works.
// Every fixture below is synthetic, stays in memory, and is never archived.
const projectRoot =
  process.env.FOOTBALL_FOCUS_TEST_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = (path) => import(pathToFileURL(join(projectRoot, path)).href);
const {
  freezeForwardManifest,
  verifyForwardManifest,
  runForwardCandidates,
  buildFirstObservedResult,
  evaluateForwardValidation,
  researchHash,
  latestForwardManifest,
  verifyForwardSourceSnapshot,
} = await load("app/forward-validation.js");
const { PREDICTION_PIPELINE_VERSION } = await load("app/prediction-model.js");
const { normalizeCompany } = await load("app/prediction-input.js");
const { buildTeamHistoryIndex } = await load("app/team-history.js");
const {hashForwardSource,forwardCodeHashes} = await load("scripts/forward-research-files.mjs");

test("frozen implementation hashes are portable across LF and Windows CRLF checkouts",async()=>{
 assert.equal(hashForwardSource("export const version=1;\n"),hashForwardSource("export const version=1;\r\n"));
 assert.notEqual(hashForwardSource("export const version=1;\n"),hashForwardSource("export const version=2;\n"));
 const active=JSON.parse(await readFile(join(projectRoot,"data/generated-forward-validation-index.json"),"utf8"));
 assert.deepEqual(await forwardCodeHashes(projectRoot),active.manifest.codeHashes,"Line ending normalization must preserve the already frozen source identity");
});

const sourceFiles = {
  prediction: "app/prediction-model.js",
  input: "app/prediction-input.js",
  asian: "app/asian-market.js",
  team: "app/team-strength-model.js",
  history: "app/team-history.js",
  forward: "app/forward-validation.js",
};
const codeHashes = Object.fromEntries(
  await Promise.all(
    Object.entries(sourceFiles).map(async ([name, path]) => [
      name,
      createHash("sha256")
        .update(await readFile(join(projectRoot, path)))
        .digest("hex"),
    ]),
  ),
);
const frozenAt = "2030-06-01T00:00:00.000Z";
const startAt = "2030-06-02T00:00:00.000Z";
const endAt = "2030-08-01T00:00:00.000Z";
const decisionAt = "2030-06-03T13:20:00.000Z";
const startedAt = "2030-06-03T13:21:00.000Z";
const completedAt = "2030-06-03T13:22:00.000Z";
const persistedAt = "2030-06-03T13:23:00.000Z";
const terminalObservedAt = "2030-06-03T16:00:00.000Z";
const sourcePage = "https://cp.zgzcw.com/dc/getKaijiangFootBall.action";
const manifestSpec = () => ({
  startAt,
  endAt,
  teamWeight: 0.25,
  codeHashes: structuredClone(codeHashes),
});
const manifest = freezeForwardManifest(manifestSpec(), frozenAt);
const emptyHistory = { schemaVersion: 1, historyVersion: researchHash([]), rows: [], excluded: 0 };
const addMs = (at, amount) => new Date(Date.parse(at) + amount).toISOString();

test("latest valid manifest is selected by frozen instant, including ISO offsets", () => {
  const early = freezeForwardManifest(manifestSpec(), "2030-06-01T11:00:00+08:00");
  const late = freezeForwardManifest(manifestSpec(), "2030-06-01T04:00:00Z");
  const invalid = { ...late, manifestHash: "0".repeat(64), frozenAt: "2030-06-01T12:00:00Z" };
  assert.ok(Date.parse(early.frozenAt) < Date.parse(late.frozenAt));
  for (const records of [
    [early, late],
    [late, early],
    [invalid, early, late],
  ])
    assert.equal(latestForwardManifest(records).manifestId, late.manifestId);
  assert.equal(latestForwardManifest([invalid]), null);
  assert.equal(latestForwardManifest([]), null);
});

test("forward source provenance permits prediction, selected-ticket and no-bet purchase snapshots", () => {
  const base = {
    snapshotId: "synthetic-provenance",
    immutable: true,
    capturedAt: addMs(decisionAt, 30000),
    reports: [report()],
  };
  const cases = [
    { ...base, recordType: "raw-prediction-snapshot" },
    { ...base, recordType: "purchase-plan-snapshot", decisionKind: "selected-tickets" },
    { ...base, recordType: "purchase-plan-snapshot", decisionKind: "no-bet-decision" },
    { ...base, recordType: "purchase-plan-snapshot", decisionKind: "no-bet-decision", reports: [] },
  ];
  for (const raw of cases)
    assert.equal(
      verifyForwardSourceSnapshot(raw, startedAt),
      true,
      raw.decisionKind || raw.recordType,
    );
  assert.equal(
    verifyForwardSourceSnapshot({ ...cases[0], capturedAt: decisionAt }, startedAt),
    true,
  );
  assert.equal(
    verifyForwardSourceSnapshot({ ...cases[0], capturedAt: startedAt }, startedAt),
    true,
  );
});

test("forward source provenance excludes mutable, unrecognised, anonymous or time-inconsistent envelopes", () => {
  const base = {
    recordType: "raw-prediction-snapshot",
    snapshotId: "synthetic-provenance",
    immutable: true,
    capturedAt: addMs(decisionAt, 30000),
    reports: [report()],
  };
  const badReport = report();
  badReport.predictionGeneratedAt = addMs(base.capturedAt, 1);
  const cases = [
    null,
    { ...base, immutable: false },
    { ...base, recordType: "capture-attempt" },
    { ...base, snapshotId: " " },
    { ...base, snapshotId: 123 },
    { ...base, capturedAt: "not-a-date" },
    { ...base, capturedAt: "2030-02-30T13:20:00Z" },
    { ...base, capturedAt: addMs(startedAt, 1) },
    { ...base, capturedAt: addMs(decisionAt, -1) },
    { ...base, reports: [badReport] },
    { ...base, reports: [{ ...report(), predictionGeneratedAt: null }] },
    { ...base, reports: null },
  ];
  for (const raw of cases)
    assert.equal(verifyForwardSourceSnapshot(raw, startedAt), false, JSON.stringify(raw));
  assert.equal(verifyForwardSourceSnapshot(base, "not-a-date"), false);
});

function company(id, at = decisionAt) {
  return normalizeCompany(
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
}

function report() {
  return {
    id: "test-991",
    officialMatchId: "991",
    salesDate: "2030-06-03",
    kickoffAt: "2030-06-03T14:00:00.000Z",
    league: "Contract League",
    home: "Contract Home",
    away: "Contract Away",
    homeTeamId: "sporttery-home",
    awayTeamId: "sporttery-away",
    officialMappingStatus: "verified",
    isMock: false,
    sourceFetchedAt: decisionAt,
    predictionGeneratedAt: decisionAt,
    modelInput: {
      schemaVersion: 1,
      pipelineVersion: PREDICTION_PIPELINE_VERSION,
      decisionAt,
      companies: [company(2), company(3)],
      official: {
        officialMatchId: "991",
        salesDate: "2030-06-03",
        kickoffAt: "2030-06-03T14:00:00.000Z",
        fetchedAt: decisionAt,
        hadOdds: [2, 3.5, 4],
        handicap: -1,
        hhadOdds: [4, 3.4, 1.8],
        totalOdds: [16, 8, 3.2, 4, 8, 16, 32, 32],
        scoreOdds: Array(31).fill(31),
        halfFullOdds: Array(9).fill(9),
      },
      matchContext: {
        status: "partial",
        officialMatchId: "991",
        observedAt: decisionAt,
        homeTeamId: "uniform-home",
        awayTeamId: "uniform-away",
        fixtures: [],
      },
    },
  };
}

function usableHistory() {
  const fixtures = Array.from({ length: 48 }, (_, index) => {
    const date = new Date(Date.UTC(2030, 3, 1 + index)).toISOString().slice(0, 10);
    const homeStrong = index % 2 === 0;
    return {
      fixtureId: `synthetic-history-${index}`,
      date,
      completedBefore: `${date}T23:59:59+08:00`,
      observedAt: "2030-05-31T00:00:00.000Z",
      homeTeamId: homeStrong ? "uniform-home" : "uniform-away",
      awayTeamId: homeStrong ? "uniform-away" : "uniform-home",
      homeGoals: homeStrong ? 4 : 0,
      awayGoals: homeStrong ? 0 : 4,
      league: "Contract League",
      sourceUrl:
        "https://webapi.sporttery.cn/gateway/uniform/football/getMatchResultV1.qry?synthetic=contract",
      datePrecision: "day",
    };
  });
  return buildTeamHistoryIndex([
    {
      immutable: true,
      snapshotId: "synthetic-history-snapshot",
      capturedAt: frozenAt,
      reports: [
        {
          isMock: false,
          officialMappingStatus: "verified",
          modelInput: { matchContext: { fixtures } },
        },
      ],
    },
  ]);
}

const goodHistory = usableHistory();
let readySeed;
let missingSeed;
function captureWith(options = {}) {
  return runForwardCandidates({
    manifest,
    report: report(),
    historyIndex: goodHistory,
    codeHashes,
    startedAt,
    clock: () => completedAt,
    ...options,
  });
}
function readyCapture() {
  readySeed ||= captureWith();
  return { ...structuredClone(readySeed), persistedAt };
}
function missingCapture() {
  missingSeed ||= captureWith({ historyIndex: emptyHistory });
  return { ...structuredClone(missingSeed), persistedAt };
}
function rehashCapture(capture) {
  const result = structuredClone(capture);
  const { captureId, contentHash, persistedAt: receiptTime, ...body } = result;
  void captureId;
  void contentHash;
  void receiptTime;
  result.contentHash = researchHash(body);
  result.captureId = `forward-capture-${result.contentHash}`;
  return result;
}

function result(overrides = {}) {
  return {
    officialMatchId: "991",
    date: "2030-06-03",
    home: "Contract Home",
    away: "Contract Away",
    fullScore: "1:0",
    halfScore: "0:0",
    hadResult: "胜",
    totalGoalsResult: "1",
    status: "settled",
    ...overrides,
  };
}
function event(overrides = {}, at = terminalObservedAt) {
  const built = buildFirstObservedResult(result(overrides), [report()], at, sourcePage);
  assert.equal(built.status, "verified", "test setup must provide a valid terminal observation");
  return built.record;
}
function evaluate(capture = readyCapture(), options = {}) {
  return evaluateForwardValidation({
    manifest,
    captures: [capture],
    resultEvents: [event()],
    fixtureUniverse: [report()],
    now: Date.parse(addMs(endAt, 86400000)),
    ...options,
  });
}
function assertCaptureExcluded(capture, message) {
  const evaluation = evaluate(capture);
  assert.equal(evaluation.sampleSize, 0, message);
  assert.equal(evaluation.coverage.captured, 0, message);
  assert.equal(evaluation.eligible, false);
}
function perturb(points) {
  const changed = structuredClone(points);
  changed[0].probability -= 0.01;
  changed[1].probability += 0.01;
  return changed;
}

test("manifest is frozen before its future window, immutable, and never automatically promotes", () => {
  assert.equal(verifyForwardManifest(manifest), true);
  assert.ok(Date.parse(manifest.frozenAt) < Date.parse(manifest.startAt));
  assert.ok(Date.parse(manifest.startAt) < Date.parse(manifest.endAt));
  assert.equal(manifest.immutable, true);
  assert.equal(manifest.automaticPromotion, false);
  assert.ok(manifest.gates.minimumPairedFixtures >= 100);
  assert.ok(manifest.gates.minimumCoverage >= 0.95);
  assert.ok(manifest.gates.blocks >= 4);
});

test("invalid, equal, reversed, or already-started manifest windows are rejected", () => {
  for (const changes of [
    { startAt: "not-a-date" },
    { endAt: "not-a-date" },
    { startAt: frozenAt },
    { startAt: addMs(frozenAt, -1) },
    { endAt: startAt },
  ]) {
    assert.throws(
      () => freezeForwardManifest({ ...manifestSpec(), ...changes }, frozenAt),
      JSON.stringify(changes),
    );
  }
});

test("a manifest cannot omit implementation hashes or silently change its fusion weight", () => {
  assert.throws(() => freezeForwardManifest({ ...manifestSpec(), codeHashes: {} }, frozenAt));
  assert.throws(() =>
    freezeForwardManifest(
      { ...manifestSpec(), codeHashes: { ...codeHashes, team: "invalid" } },
      frozenAt,
    ),
  );
  assert.equal(verifyForwardManifest({ ...manifest, teamWeight: 0.75 }), false);
  assert.equal(verifyForwardManifest({ ...manifest, startAt: addMs(startAt, 1) }), false);
});

test("new capture holds independent team output, a fixed fusion, and a complete odds distribution", () => {
  const original = report();
  const untouched = structuredClone(original);
  const capture = captureWith({ report: original });
  assert.deepEqual(original, untouched);
  assert.equal(capture.shadowOnly, true);
  assert.equal(capture.usesXg, false);
  for (const name of manifest.candidates) {
    assert.equal(capture.candidates[name].status, "ready", name);
    assert.equal(capture.candidates[name].fullScoreDistribution.length, 169);
    assert.ok(
      Math.abs(
        capture.candidates[name].fullScoreDistribution.reduce(
          (sum, point) => sum + point.probability,
          0,
        ) - 100,
      ) < 1e-8,
    );
  }
  const odds = new Map(
    capture.candidates["odds-baseline"].fullScoreDistribution.map((point) => [
      point.score,
      point.probability,
    ]),
  );
  const team = new Map(
    capture.candidates["team-only"].fullScoreDistribution.map((point) => [
      point.score,
      point.probability,
    ]),
  );
  for (const point of capture.candidates["odds-plus-team"].fullScoreDistribution) {
    assert.ok(
      Math.abs(
        point.probability -
          odds.get(point.score) * (1 - manifest.teamWeight) -
          team.get(point.score) * manifest.teamWeight,
      ) < 1e-9,
    );
  }
});

test("candidate code must match the manifest that was frozen", () => {
  assert.throws(() => captureWith({ codeHashes: { ...codeHashes, team: "0".repeat(64) } }));
});

test("historical inputs are never backfilled as new prospective captures", () => {
  const old = report();
  old.modelInput.decisionAt = addMs(startAt, -1);
  old.predictionGeneratedAt = old.modelInput.decisionAt;
  old.sourceFetchedAt = old.modelInput.decisionAt;
  old.modelInput.companies = [
    company(2, old.modelInput.decisionAt),
    company(3, old.modelInput.decisionAt),
  ];
  old.modelInput.official.fetchedAt = old.modelInput.decisionAt;
  old.modelInput.matchContext.observedAt = old.modelInput.decisionAt;
  assert.throws(() => captureWith({ report: old }));
});

test("unverified identity and mock reports never enter the future cohort", () => {
  for (const changes of [
    { isMock: true },
    { officialMappingStatus: "unmatched" },
    { officialMatchId: "not-an-official-id" },
  ]) {
    assert.throws(() => captureWith({ report: { ...report(), ...changes } }));
  }
});

test("report fixture and frozen input fixture must be the same official match", () => {
  const mismatch = report();
  mismatch.modelInput.official.officialMatchId = "992";
  assert.throws(() => captureWith({ report: mismatch }));
});

test("company or official data first observed after decision cannot enter that decision input", () => {
  const companyFuture = report();
  companyFuture.modelInput.companies[0].fetchedAt = addMs(decisionAt, 1);
  assert.throws(() => captureWith({ report: companyFuture }));
  const officialFuture = report();
  officialFuture.modelInput.official.fetchedAt = addMs(decisionAt, 1);
  assert.throws(() => captureWith({ report: officialFuture }));
});

test("candidate computation cannot finish after target, kickoff, or before it started", () => {
  const targetAt = readyCapture().decisionTargetAt;
  for (const finish of [addMs(targetAt, 1), report().kickoffAt, addMs(startedAt, -1)]) {
    assert.throws(() => captureWith({ clock: () => finish }));
  }
});

test("missing team data cannot fall back to odds under the team or fusion label", () => {
  const currentOnly = report();
  currentOnly.modelInput.matchContext.fixtures = structuredClone(goodHistory.rows);
  const capture = captureWith({ report: currentOnly, historyIndex: emptyHistory });
  assert.equal(capture.candidates["odds-baseline"].status, "ready");
  for (const name of ["team-only", "odds-plus-team"]) {
    assert.notEqual(capture.candidates[name].status, "ready");
    assert.equal(capture.candidates[name].fullScoreDistribution, undefined);
  }
  const assessed = evaluate({ ...capture, persistedAt });
  assert.equal(assessed.sampleSize, 0);
  assert.equal(assessed.coverage.paired, 0);
  assert.equal(assessed.eligible, false);
});

test("an untampered capture replays into one same-fixture ablation", () => {
  const assessed = evaluate();
  assert.equal(assessed.sampleSize, 1);
  for (const name of manifest.candidates) assert.equal(assessed.models[name].sampleSize, 1);
  assert.equal(assessed.market.sampleSize, 1);
  assert.equal(assessed.excluded.length, 0);
});

test("receipt is required and must follow computation while remaining at or before target", () => {
  const absent = readyCapture();
  delete absent.persistedAt;
  assertCaptureExcluded(absent, "missing receipt");
  assertCaptureExcluded(
    { ...readyCapture(), persistedAt: addMs(completedAt, -1) },
    "receipt before completion",
  );
  assertCaptureExcluded(
    { ...readyCapture(), persistedAt: addMs(readyCapture().decisionTargetAt, 1) },
    "receipt after target",
  );
});

test("stored target cannot be extended to accept an otherwise late capture", () => {
  const capture = readyCapture();
  const realTarget = capture.decisionTargetAt;
  capture.decisionTargetAt = addMs(realTarget, 60000);
  capture.completedAt = addMs(realTarget, 1000);
  capture.persistedAt = addMs(realTarget, 2000);
  assertCaptureExcluded(
    rehashCapture(capture),
    "evaluator must derive the target from the fixture",
  );
});

test("invalid completion time and fixture identity are rejected even when payload is rehashed", () => {
  const invalidTime = readyCapture();
  invalidTime.completedAt = "not-a-date";
  assertCaptureExcluded(rehashCapture(invalidTime));
  const wrongFixture = readyCapture();
  wrongFixture.fixture.officialMatchId = "992";
  assertCaptureExcluded(rehashCapture(wrongFixture));
});

test("captures outside the frozen official fixture universe do not enlarge the paired cohort", () => {
  const assessed = evaluate(readyCapture(), { fixtureUniverse: [] });
  assert.equal(assessed.sampleSize, 0);
  assert.equal(assessed.coverage.expected, 0);
  assert.equal(assessed.eligible, false);
});

test("input or history tampering cannot bypass hashes", () => {
  const inputChanged = readyCapture();
  inputChanged.input.companies[0].win += 0.1;
  assertCaptureExcluded(inputChanged);
  const historyChanged = readyCapture();
  historyChanged.history.rows[0].homeGoals += 1;
  assertCaptureExcluded(historyChanged);
});

test("self-consistent payload hashes do not excuse odds, team, or fusion replay mismatch", () => {
  for (const name of manifest.candidates) {
    const capture = readyCapture();
    capture.candidates[name].fullScoreDistribution = perturb(
      capture.candidates[name].fullScoreDistribution,
    );
    assertCaptureExcluded(rehashCapture(capture), `${name} must be replayed`);
  }
});

test("matching result is first observed honestly and does not invent an actual ending time", () => {
  const first = event();
  const later = event({}, addMs(terminalObservedAt, 3600000));
  assert.equal(first.firstObservedAt, terminalObservedAt);
  assert.equal(first.endedAt, null);
  assert.equal(first.endedBeforeAt, terminalObservedAt);
  assert.equal(
    first.eventId,
    later.eventId,
    "re-observation of the same outcome has a stable event identity",
  );
  assert.equal(first.sourceAuthority, "secondary-published-lottery-results");
  assert.equal(first.fixtureKey, "2030-06-03|991");
});

test("a live score or inconsistent published categorical result is insufficient finality proof", () => {
  for (const changes of [
    { status: "live" },
    { hadResult: "" },
    { hadResult: "负" },
    { totalGoalsResult: "" },
    { totalGoalsResult: "2" },
    { fullScore: "pending" },
  ]) {
    assert.equal(
      buildFirstObservedResult(result(changes), [report()], terminalObservedAt, sourcePage).status,
      "rejected",
      JSON.stringify(changes),
    );
  }
});

test("result observations need a trusted supported source and actual post-kickoff observation", () => {
  for (const [at, page] of [
    ["not-a-date", sourcePage],
    [report().kickoffAt, sourcePage],
    [addMs(report().kickoffAt, -1), sourcePage],
    [terminalObservedAt, "http://cp.zgzcw.com/results"],
    [terminalObservedAt, "https://untrusted.invalid/results"],
  ]) {
    assert.equal(
      buildFirstObservedResult(result(), [report()], at, page).status,
      "rejected",
      `${at} ${page}`,
    );
  }
});

test("result date, official identity, venue order, and unique schedule must match the captured fixture", () => {
  for (const changes of [
    { officialMatchId: "992" },
    { date: "2030-06-04" },
    { home: "Contract Away", away: "Contract Home" },
  ]) {
    assert.equal(
      buildFirstObservedResult(result(changes), [report()], terminalObservedAt, sourcePage).status,
      "rejected",
    );
  }
  const ambiguous = [report(), { ...report(), kickoffAt: addMs(report().kickoffAt, 3600000) }];
  assert.equal(
    buildFirstObservedResult(result(), ambiguous, terminalObservedAt, sourcePage).status,
    "rejected",
  );
});

test("future observed result events are invisible at the earlier evaluation clock", () => {
  const capture = readyCapture();
  const assessed = evaluate(capture, { now: Date.parse(addMs(terminalObservedAt, -1)) });
  assert.equal(assessed.sampleSize, 0);
  assert.equal(assessed.coverage.resolvedDueResults, 0);
});

test("tampering a trusted event outcome without matching its provenance cannot score a fixture", () => {
  const corrupted = event();
  corrupted.fullScore = "0:1";
  corrupted.homeGoals = 0;
  corrupted.awayGoals = 1;
  corrupted.hadResult = "负";
  const assessed = evaluate(readyCapture(), { resultEvents: [corrupted] });
  assert.equal(assessed.sampleSize, 0);
  assert.equal(assessed.eligible, false);
});

test("re-observing the same outcome counts once; conflicting terminal outcomes are held out", () => {
  const capture = readyCapture();
  const sameOutcome = [event({}, addMs(terminalObservedAt, 3600000)), event()];
  assert.equal(evaluate(capture, { resultEvents: sameOutcome }).sampleSize, 1);
  const conflict = event({ fullScore: "0:1", hadResult: "负" });
  const held = evaluate(capture, { resultEvents: [event(), conflict] });
  assert.equal(held.sampleSize, 0);
  assert.ok(held.excluded.some((item) => /result.*conflict/.test(item.reason)));
  assert.equal(held.eligible, false);
});

test("an open window or underpowered sample never satisfies prospective promotion gates", () => {
  const capture = readyCapture();
  const collecting = evaluate(capture, { now: Date.parse(addMs(terminalObservedAt, 1)) });
  assert.equal(collecting.eligible, false);
  assert.equal(collecting.automaticPromotion, false);
  assert.equal(collecting.gates.find((gate) => gate.key === "window").passed, false);
  const closed = evaluate(capture);
  assert.equal(closed.sampleSize, 1);
  assert.equal(closed.gates.find((gate) => gate.key === "sample").passed, false);
  assert.equal(closed.eligible, false);
  assert.equal(closed.automaticPromotion, false);
  assert.deepEqual(
    manifest,
    freezeForwardManifest(manifestSpec(), frozenAt),
    "evaluation cannot tune the frozen protocol",
  );
});

test(
  "a fully paired synthetic future cohort can pass review gates without automatic promotion",
  { timeout: 60000 },
  () => {
    const captures = [],
      resultEvents = [],
      fixtureUniverse = [];
    // This artificial all-home-win cohort exercises the positive gate path only.
    // It is not a backtest, an accuracy claim, or production evidence.
    for (let block = 0; block < 4; block++) {
      for (let item = 0; item < 25; item++) {
        const index = block * 25 + item;
        const day = new Date(Date.parse(startAt) + (block * 15 + Math.floor(item / 3)) * 86400000)
          .toISOString()
          .slice(0, 10);
        const current = report(),
          id = String(10000 + index),
          inputAt = `${day}T13:20:00.000Z`;
        Object.assign(current, {
          officialMatchId: id,
          id: `synthetic-future-${id}`,
          salesDate: day,
          kickoffAt: `${day}T14:00:00.000Z`,
          sourceFetchedAt: inputAt,
          predictionGeneratedAt: inputAt,
        });
        current.modelInput.decisionAt = inputAt;
        current.modelInput.companies = [company(2, inputAt), company(3, inputAt)];
        Object.assign(current.modelInput.official, {
          officialMatchId: id,
          salesDate: day,
          kickoffAt: current.kickoffAt,
          fetchedAt: inputAt,
        });
        Object.assign(current.modelInput.matchContext, {
          officialMatchId: id,
          observedAt: inputAt,
        });
        const capture = captureWith({
          report: current,
          startedAt: `${day}T13:21:00.000Z`,
          clock: () => `${day}T13:22:00.000Z`,
        });
        captures.push({ ...capture, persistedAt: `${day}T13:23:00.000Z` });
        fixtureUniverse.push(current);
        const built = buildFirstObservedResult(
          result({ officialMatchId: id, date: day }),
          [current],
          `${day}T16:00:00.000Z`,
          sourcePage,
        );
        assert.equal(built.status, "verified");
        resultEvents.push(built.record);
      }
    }
    const assessed = evaluateForwardValidation({
      manifest,
      captures,
      resultEvents,
      fixtureUniverse,
      now: Date.parse(addMs(endAt, 86400000)),
    });
    assert.equal(assessed.sampleSize, 100);
    assert.equal(assessed.coverage.expected, 100);
    assert.equal(assessed.coverage.paired, 100);
    assert.equal(assessed.excluded.length, 0);
    assert.ok(
      assessed.gates.every((gate) => gate.passed),
      JSON.stringify(assessed.gates),
    );
    assert.equal(assessed.eligible, true, "passing means eligible for human review only");
    assert.equal(assessed.automaticPromotion, false);
    assert.equal(manifest.automaticPromotion, false);
  },
);

test("no frozen experiment remains explicitly ineligible", () => {
  const assessed = evaluateForwardValidation({
    manifest: null,
    captures: [],
    resultEvents: [],
    fixtureUniverse: [],
    now: Date.parse(endAt),
  });
  assert.equal(assessed.status, "not-frozen");
  assert.equal(assessed.eligible, false);
  assert.equal(assessed.sampleSize, 0);
});
