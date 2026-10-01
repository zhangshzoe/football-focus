import { createHash } from "node:crypto";
import { predictFromSnapshot, projectScoreMarkets } from "./prediction-model.js";
import { fitTeamStrength } from "./team-strength-model.js";
import { selectTeamHistory } from "./team-history.js";
import { decisionTargetAt } from "./snapshot-decision-policy.js";
import {
  completeDistribution,
  EXACT_SCORE_LABELS,
  frozenOfficialMarkets,
  pairedInterval,
  scoreProbability,
  summarizeProbability,
} from "./probability-evaluation.js";

export const FORWARD_PROTOCOL = "frozen-forward-ablation-v1";
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, stable(value[key])]),
        )
      : value;
export const researchHash = (value) =>
  createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
const dated = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  )
    return false;
  const [year, month, day, hour, minute, second] = value
    .match(/^\d{4}|\d{2}/g)
    .slice(0, 6)
    .map(Number);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year, month, 0)).getUTCDate() &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    Number.isFinite(Date.parse(value))
  );
};
const fixtureKey = (row) => `${row.salesDate}|${row.officialMatchId}`;
const validScope = (row) =>
  row &&
  /^\d{4}-\d{2}-\d{2}$/.test(row.salesDate || "") &&
  dated(`${row.salesDate}T00:00:00+08:00`) &&
  /^\d+$/.test(String(row.officialMatchId || "")) &&
  dated(row.kickoffAt);
const validIdentity = (row) =>
  validScope(row) &&
  typeof row.home === "string" &&
  Boolean(row.home.trim()) &&
  typeof row.away === "string" &&
  Boolean(row.away.trim());
const canonicalFixture = (row) => ({
  officialMatchId: String(row.officialMatchId),
  salesDate: row.salesDate,
  kickoffAt: new Date(row.kickoffAt).toISOString(),
  home: row.home,
  away: row.away,
  league: row.league,
});
const sourceAllowed = (page) => {
  try {
    const url = new URL(page);
    return (
      url.origin === "https://cp.zgzcw.com" &&
      url.pathname === "/dc/getKaijiangFootBall.action" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
};
const inputMatchesFixture = (input, fixture) =>
  input?.official &&
  String(input.official.officialMatchId) === String(fixture.officialMatchId) &&
  input.official.salesDate === fixture.salesDate &&
  Date.parse(input.official.kickoffAt) === Date.parse(fixture.kickoffAt);
const inputAvailable = (input) =>
  dated(input?.decisionAt) &&
  Array.isArray(input.companies) &&
  input.companies.length > 0 &&
  [
    input.official?.fetchedAt,
    ...input.companies.map((company) => company.fetchedAt),
    ...(input.matchContext?.observedAt ? [input.matchContext.observedAt] : []),
  ].every((at) => dated(at) && Date.parse(at) <= Date.parse(input.decisionAt));

export function freezeForwardManifest(spec, frozenAt) {
  if (
    !dated(frozenAt) ||
    !dated(spec.startAt) ||
    !dated(spec.endAt) ||
    Date.parse(spec.startAt) <= Date.parse(frozenAt) ||
    Date.parse(spec.endAt) <= Date.parse(spec.startAt)
  )
    throw new Error("未来验证必须先冻结，再开始采样");
  if (
    !spec.codeHashes ||
    Object.values(spec.codeHashes).some((hash) => !/^[a-f0-9]{64}$/.test(hash)) ||
    Object.keys(spec.codeHashes).length < 5
  )
    throw new Error("模型实现哈希缺失");
  if (!(spec.teamWeight > 0 && spec.teamWeight < 1)) throw new Error("球队融合权重无效");
  const body = {
    schemaVersion: 1,
    recordType: "forward-validation-manifest",
    immutable: true,
    protocol: FORWARD_PROTOCOL,
    frozenAt,
    startAt: spec.startAt,
    endAt: spec.endAt,
    codeHashes: spec.codeHashes,
    teamWeight: spec.teamWeight,
    candidates: ["odds-baseline", "team-only", "odds-plus-team"],
    baselineParameters: { temperature: 1, lowScoreRho: 0, goalDispersion: 1 },
    historyPolicy: "observed-archive-before-decision-no-current-request-v1",
    universePolicy: "all-captured-official-fixture-manifests",
    decisionPolicy: "actual_information_not_after_fixed_target_v2",
    decisionWindowMinutes: 15,
    gates: {
      minimumPairedFixtures: 100,
      blocks: 4,
      minimumWinningBlocks: 3,
      minimumBrierGain: 0.005,
      minimumCoverage: 0.95,
      maximumLogLossDelta: 0,
      maximumEceDelta: 0,
    },
    primaryMarket: "had",
    automaticPromotion: false,
  };
  const manifestHash = researchHash(body);
  return { ...body, manifestHash, manifestId: `forward-${manifestHash.slice(0, 20)}` };
}

export function verifyForwardManifest(manifest) {
  if (!manifest || manifest.protocol !== FORWARD_PROTOCOL || manifest.immutable !== true)
    return false;
  try {
    const expected = freezeForwardManifest(manifest, manifest.frozenAt);
    return (
      expected.manifestHash === manifest.manifestHash &&
      expected.manifestId === manifest.manifestId &&
      researchHash(expected) === researchHash(manifest)
    );
  } catch {
    return false;
  }
}

export function latestForwardManifest(manifests = []) {
  return (
    manifests
      .filter(verifyForwardManifest)
      .sort((a, b) => Date.parse(b.frozenAt) - Date.parse(a.frozenAt))[0] || null
  );
}

// Production prediction and purchase/no-bet decisions both carry raw reports.
export function verifyForwardSourceSnapshot(raw, receivedAt) {
  if (
    !raw ||
    !["raw-prediction-snapshot", "purchase-plan-snapshot"].includes(raw.recordType) ||
    raw.immutable !== true ||
    typeof raw.snapshotId !== "string" ||
    !raw.snapshotId.trim() ||
    !dated(raw.capturedAt) ||
    !dated(receivedAt) ||
    !Array.isArray(raw.reports)
  )
    return false;
  const captured = Date.parse(raw.capturedAt);
  return (
    captured <= Date.parse(receivedAt) &&
    raw.reports.every(
      (report) =>
        dated(report?.predictionGeneratedAt) &&
        Date.parse(report.predictionGeneratedAt) <= captured,
    )
  );
}

// Called only for a newly captured immutable input. No historical backfill path.
export function runForwardCandidates({
  manifest,
  report,
  historyIndex,
  codeHashes,
  startedAt,
  clock = () => new Date().toISOString(),
}) {
  if (
    !verifyForwardManifest(manifest) ||
    researchHash(codeHashes) !== researchHash(manifest.codeHashes)
  )
    throw new Error("冻结候选实现已变化，需新建未来验证版本");
  const decisionAt = report.modelInput?.decisionAt,
    targetAt = decisionTargetAt(report.salesDate, report.kickoffAt);
  if (
    !validIdentity(report) ||
    report.isMock ||
    report.officialMappingStatus !== "verified" ||
    !dated(startedAt) ||
    !dated(decisionAt) ||
    !targetAt
  )
    throw new Error("候选输入身份或实际时刻无效");
  if (!inputMatchesFixture(report.modelInput, report) || !inputAvailable(report.modelInput))
    throw new Error("冻结输入身份或来源实际观测时刻无法核验");
  if (Date.parse(decisionAt) > Date.parse(startedAt)) throw new Error("输入时刻在候选开始之后");
  const input = structuredClone(report.modelInput),
    selected = selectTeamHistory(historyIndex, { league: report.league, decisionAt });
  // Never mix official sporttery team IDs with uniform-context team IDs.
  const context = input.matchContext || {},
    team = fitTeamStrength(selected.rows, {
      league: report.league,
      homeTeamId: context.homeTeamId,
      awayTeamId: context.awayTeamId,
      decisionAt,
    });
  const odds = predictFromSnapshot(input, manifest.baselineParameters).fullScoreDistribution;
  if (!completeDistribution(odds, EXACT_SCORE_LABELS)) throw new Error("赔率基线缺少完整比分分布");
  const candidates = {
    "odds-baseline": { status: "ready", fullScoreDistribution: odds },
    "team-only": { ...team },
    "odds-plus-team": { status: "insufficient-data", reason: "独立球队数据不足，不以赔率候选替代" },
  };
  if (
    team.status === "ready" &&
    !selected.conflicts.length &&
    completeDistribution(team.fullScoreDistribution, EXACT_SCORE_LABELS)
  ) {
    const byScore = new Map(
      team.fullScoreDistribution.map((point) => [point.score, point.probability]),
    );
    candidates["odds-plus-team"] = {
      status: "ready",
      fullScoreDistribution: odds.map((point) => ({
        score: point.score,
        probability:
          point.probability * (1 - manifest.teamWeight) +
          byScore.get(point.score) * manifest.teamWeight,
      })),
    };
  }
  if (selected.conflicts.length)
    candidates["team-only"] = { status: "conflicting-history", shadowOnly: true };
  const completedAt = clock(),
    timeValues = [
      startedAt,
      completedAt,
      decisionAt,
      report.predictionGeneratedAt,
      report.sourceFetchedAt,
    ],
    times = timeValues.map(Date.parse);
  if (
    timeValues.some((time) => !dated(time)) ||
    Date.parse(report.sourceFetchedAt) > Date.parse(decisionAt) ||
    Date.parse(report.predictionGeneratedAt) < Date.parse(decisionAt) ||
    Date.parse(report.predictionGeneratedAt) > Date.parse(startedAt) ||
    Date.parse(startedAt) < Date.parse(manifest.frozenAt) ||
    Date.parse(decisionAt) < Date.parse(manifest.startAt) ||
    Date.parse(decisionAt) >= Date.parse(manifest.endAt) ||
    Date.parse(targetAt) < Date.parse(manifest.startAt) ||
    Date.parse(targetAt) >= Date.parse(manifest.endAt) ||
    Date.parse(completedAt) >= Date.parse(manifest.endAt) ||
    Date.parse(decisionAt) < Date.parse(targetAt) - manifest.decisionWindowMinutes * 60000 ||
    Date.parse(completedAt) < Date.parse(startedAt) ||
    Math.max(...times) > Date.parse(targetAt) ||
    Math.max(...times) >= Date.parse(report.kickoffAt)
  )
    throw new Error("候选不在冻结后的真实赛前决策窗口内");
  const body = {
    schemaVersion: 1,
    recordType: "forward-candidate-capture",
    immutable: true,
    manifestId: manifest.manifestId,
    manifestHash: manifest.manifestHash,
    fixture: canonicalFixture(report),
    startedAt,
    completedAt,
    decisionAt,
    predictionGeneratedAt: report.predictionGeneratedAt,
    sourceFetchedAt: report.sourceFetchedAt,
    decisionTargetAt: targetAt,
    input,
    inputHash: researchHash(input),
    history: selected,
    historyHash: researchHash(selected),
    candidates,
    officialBaseline: frozenOfficialMarkets(input),
    usesXg: false,
    shadowOnly: true,
  };
  return {
    ...body,
    captureId: `forward-capture-${researchHash(body)}`,
    contentHash: researchHash(body),
  };
}

export function buildFirstObservedResult(result, fixtures, observedAt, sourcePage) {
  if (!dated(observedAt) || !sourceAllowed(sourcePage))
    return { status: "rejected", reason: "missing-source-time" };
  const id = String(result.officialMatchId || result.matchId || ""),
    date = result.salesDate || result.date;
  const matches = fixtures.filter(
    (row) => validIdentity(row) && String(row.officialMatchId) === id && row.salesDate === date,
  );
  const identities = new Map(
    matches.map((row) => [researchHash([row.home, row.away, Date.parse(row.kickoffAt)]), row]),
  );
  const fixture = identities.size === 1 ? [...identities.values()][0] : null;
  const compactName = (value) =>
    String(value || "")
      .normalize("NFKC")
      .replace(/\s+/g, "");
  if (
    !fixture ||
    compactName(result.home) !== compactName(fixture.home) ||
    compactName(result.away) !== compactName(fixture.away)
  )
    return { status: "rejected", reason: "fixture-identity-unverified" };
  const score = /^(\d{1,2}):(\d{1,2})$/.exec(result.fullScore || "");
  if (
    !score ||
    result.status !== "settled" ||
    Date.parse(observedAt) <= Date.parse(fixture.kickoffAt)
  )
    return { status: "rejected", reason: "terminal-result-unverified" };
  const homeGoals = Number(score[1]),
    awayGoals = Number(score[2]),
    had = homeGoals > awayGoals ? "胜" : homeGoals === awayGoals ? "平" : "负",
    total = homeGoals + awayGoals >= 7 ? "7+" : String(homeGoals + awayGoals);
  // Published categorical result cells are necessary; a live score alone is not finality proof.
  if (
    result.hadResult !== had ||
    String(result.totalGoalsResult || "").replace(/球/g, "") !== total
  )
    return { status: "rejected", reason: "published-result-cells-inconsistent" };
  const outcomeHash = researchHash({ fullScore: result.fullScore, had, total });
  const body = {
    schemaVersion: 1,
    recordType: "first-observed-result-event",
    immutable: true,
    fixtureKey: fixtureKey(fixture),
    fixture: canonicalFixture(fixture),
    fullScore: result.fullScore,
    homeGoals,
    awayGoals,
    hadResult: had,
    totalGoalsResult: total,
    firstObservedAt: observedAt,
    endedAt: null,
    endedBeforeAt: observedAt,
    endTimeBasis: "first-verified-terminal-observation-upper-bound",
    sourcePage,
    sourceAuthority: "secondary-published-lottery-results",
    sourceResult: structuredClone(result),
    responseHash: researchHash(result),
    outcomeHash,
  };
  return {
    status: "verified",
    record: {
      ...body,
      eventId: `result-${researchHash([body.fixtureKey, sourcePage, outcomeHash])}`,
      contentHash: researchHash(body),
    },
  };
}

export function verifyFirstObservedResult(record, { now = Number.POSITIVE_INFINITY } = {}) {
  if (!record || record.recordType !== "first-observed-result-event" || record.immutable !== true)
    return false;
  if (
    !(Number.isFinite(now) || now === Number.POSITIVE_INFINITY) ||
    Date.parse(record.firstObservedAt) > now
  )
    return false;
  try {
    const rebuilt = buildFirstObservedResult(
      record.sourceResult,
      [record.fixture],
      record.firstObservedAt,
      record.sourcePage,
    );
    return rebuilt.status === "verified" && researchHash(rebuilt.record) === researchHash(record);
  } catch {
    return false;
  }
}

export function mergeFirstObservedResults(records, { now = Number.POSITIVE_INFINITY } = {}) {
  const unique = new Map(),
    invalid = [];
  for (const record of records || []) {
    if (!verifyFirstObservedResult(record, { now })) {
      invalid.push({ eventId: record?.eventId || null, reason: "result-event-integrity-invalid" });
      continue;
    }
    const previous = unique.get(record.eventId);
    if (!previous || Date.parse(record.firstObservedAt) < Date.parse(previous.firstObservedAt))
      unique.set(record.eventId, record);
  }
  return {
    records: [...unique.values()].sort(
      (a, b) =>
        Date.parse(a.firstObservedAt) - Date.parse(b.firstObservedAt) ||
        a.eventId.localeCompare(b.eventId),
    ),
    invalid,
  };
}

export function evaluateForwardValidation({
  manifest,
  captures = [],
  resultEvents = [],
  fixtureUniverse = [],
  now = Date.now(),
}) {
  if (!verifyForwardManifest(manifest))
    return { status: "not-frozen", eligible: false, reason: "尚无有效冻结版本", sampleSize: 0 };
  const start = Date.parse(manifest.startAt),
    end = Date.parse(manifest.endAt),
    targets = new Map(),
    events = new Map(),
    chosen = new Map(),
    excluded = [],
    scopeConflicts = new Set();
  if (!Number.isFinite(now))
    return { status: "invalid-evaluation-time", eligible: false, sampleSize: 0 };
  for (const fixture of fixtureUniverse) {
    const at = Date.parse(decisionTargetAt(fixture?.salesDate, fixture?.kickoffAt) || "");
    if (validScope(fixture) && at >= start && at < end && at <= now) {
      const key = fixtureKey(fixture),
        previous = targets.get(key);
      if (
        previous &&
        (Date.parse(previous.kickoffAt) !== Date.parse(fixture.kickoffAt) ||
          (previous.home && fixture.home && previous.home !== fixture.home) ||
          (previous.away && fixture.away && previous.away !== fixture.away))
      )
        scopeConflicts.add(key);
      if (!previous || (!previous.home && fixture.home)) targets.set(key, fixture);
    }
  }
  for (const key of scopeConflicts) excluded.push({ key, reason: "official-scope-conflict" });
  const merged = mergeFirstObservedResults(resultEvents, { now });
  excluded.push(...merged.invalid);
  for (const event of merged.records) {
    if (Date.parse(event.firstObservedAt) > now) continue;
    events.set(event.fixtureKey, [...(events.get(event.fixtureKey) || []), event]);
  }
  for (const capture of captures) {
    const key = fixtureKey(capture.fixture || {}),
      target = Date.parse(capture.decisionTargetAt || ""),
      completed = Date.parse(capture.completedAt || "");
    const { captureId, contentHash, persistedAt, ...body } = capture;
    if (
      capture.manifestHash !== manifest.manifestHash ||
      capture.recordType !== "forward-candidate-capture"
    )
      continue;
    const scope = targets.get(key),
      derivedTarget = decisionTargetAt(capture.fixture?.salesDate, capture.fixture?.kickoffAt),
      times = [
        capture.startedAt,
        capture.completedAt,
        capture.decisionAt,
        capture.predictionGeneratedAt,
        capture.sourceFetchedAt,
        persistedAt,
      ];
    if (
      !scope ||
      scopeConflicts.has(key) ||
      !validIdentity(capture.fixture) ||
      Date.parse(scope.kickoffAt) !== Date.parse(capture.fixture.kickoffAt) ||
      (scope.home && scope.home !== capture.fixture.home) ||
      (scope.away && scope.away !== capture.fixture.away) ||
      capture.immutable !== true ||
      capture.manifestId !== manifest.manifestId ||
      captureId !== `forward-capture-${contentHash}` ||
      researchHash(body) !== contentHash ||
      researchHash(capture.input) !== capture.inputHash ||
      researchHash(capture.history) !== capture.historyHash ||
      !inputMatchesFixture(capture.input, capture.fixture) ||
      !inputAvailable(capture.input) ||
      capture.input.decisionAt !== capture.decisionAt ||
      researchHash(capture.officialBaseline) !==
        researchHash(frozenOfficialMarkets(capture.input)) ||
      times.some((time) => !dated(time)) ||
      Date.parse(capture.sourceFetchedAt) > Date.parse(capture.decisionAt) ||
      Date.parse(capture.predictionGeneratedAt) < Date.parse(capture.decisionAt) ||
      Date.parse(capture.predictionGeneratedAt) > Date.parse(capture.startedAt) ||
      Date.parse(capture.startedAt) < Date.parse(manifest.frozenAt) ||
      Date.parse(capture.startedAt) < Date.parse(capture.decisionAt) ||
      completed < Date.parse(capture.startedAt) ||
      Date.parse(persistedAt) < completed ||
      Date.parse(persistedAt) > now ||
      Date.parse(persistedAt) > target ||
      completed > target ||
      completed < start ||
      completed >= end ||
      !derivedTarget ||
      Date.parse(derivedTarget) !== target ||
      Date.parse(capture.decisionAt) <
        Math.max(start, target - manifest.decisionWindowMinutes * 60000) ||
      Date.parse(persistedAt) >= Date.parse(capture.fixture.kickoffAt)
    ) {
      excluded.push({ key, reason: "capture-time-or-hash-invalid" });
      continue;
    }
    // Replay frozen input and frozen historical rows, not today's model parameters.
    try {
      const replay = predictFromSnapshot(
        capture.input,
        manifest.baselineParameters,
      ).fullScoreDistribution;
      if (
        researchHash(replay) !==
        researchHash(capture.candidates["odds-baseline"]?.fullScoreDistribution)
      )
        throw new Error("replay mismatch");
      const context = capture.input.matchContext || {},
        team = fitTeamStrength(capture.history.rows, {
          league: capture.fixture.league,
          homeTeamId: context.homeTeamId,
          awayTeamId: context.awayTeamId,
          decisionAt: capture.decisionAt,
        });
      if (
        capture.candidates["team-only"]?.status === "ready" &&
        researchHash(team.fullScoreDistribution) !==
          researchHash(capture.candidates["team-only"].fullScoreDistribution)
      )
        throw new Error("team replay mismatch");
      if (capture.candidates["odds-plus-team"]?.status === "ready") {
        const teamPoints = new Map(
          (team.fullScoreDistribution || []).map((p) => [p.score, p.probability]),
        );
        const fused = replay.map((p) => ({
          score: p.score,
          probability:
            p.probability * (1 - manifest.teamWeight) +
            teamPoints.get(p.score) * manifest.teamWeight,
        }));
        if (
          researchHash(fused) !==
          researchHash(capture.candidates["odds-plus-team"].fullScoreDistribution)
        )
          throw new Error("fusion replay mismatch");
      }
    } catch {
      excluded.push({ key, reason: "frozen-input-replay-failed" });
      continue;
    }
    if (!chosen.has(key) || completed > Date.parse(chosen.get(key).completedAt))
      chosen.set(key, capture);
  }
  const rows = [],
    dueKeys = [...targets.keys()].filter(
      (key) => Date.parse(targets.get(key).kickoffAt) < now - 86400000,
    ),
    resolved = new Set();
  for (const [key, capture] of chosen) {
    const facts = (events.get(key) || []).sort(
      (a, b) => Date.parse(a.firstObservedAt) - Date.parse(b.firstObservedAt),
    );
    if (new Set(facts.map((event) => event.outcomeHash)).size > 1) {
      excluded.push({ key, reason: "result-conflict" });
      continue;
    }
    const fact = facts[0];
    if (
      !fact ||
      researchHash(fact.fixture) !== researchHash(capture.fixture) ||
      Date.parse(fact.firstObservedAt) <= Date.parse(capture.persistedAt)
    )
      continue;
    resolved.add(key);
    const actual = ["胜", "平", "负"].indexOf(fact.hadResult),
      scores = {};
    for (const [name, candidate] of Object.entries(capture.candidates))
      if (
        candidate.status === "ready" &&
        completeDistribution(candidate.fullScoreDistribution, EXACT_SCORE_LABELS)
      )
        scores[name] = scoreProbability(
          projectScoreMarkets(candidate.fullScoreDistribution).had,
          actual,
        );
    const market = scoreProbability(capture.officialBaseline?.had, actual);
    if (scores["odds-baseline"] && scores["team-only"] && scores["odds-plus-team"] && market)
      rows.push({
        key,
        salesDate: capture.fixture.salesDate,
        targetAt: capture.decisionTargetAt,
        scores,
        market,
      });
  }
  rows.sort((a, b) => a.targetAt.localeCompare(b.targetAt) || a.key.localeCompare(b.key));
  const models = Object.fromEntries(
    manifest.candidates.map((name) => [
      name,
      summarizeProbability(rows.map((row) => row.scores[name])),
    ]),
  );
  const market = summarizeProbability(rows.map((row) => row.market)),
    fused = models["odds-plus-team"],
    odds = models["odds-baseline"];
  const versus = (name) =>
    pairedInterval(
      rows.map((row) => ({
        ...row,
        model: row.scores["odds-plus-team"],
        market: name === "official" ? row.market : row.scores[name],
      })),
    );
  const oddsInterval = versus("odds-baseline"),
    marketInterval = versus("official");
  const blocks = Array.from({ length: manifest.gates.blocks }, (_, index) => {
    const blockRows = rows.filter(
      (row) =>
        Math.min(
          manifest.gates.blocks - 1,
          Math.floor(((Date.parse(row.targetAt) - start) / (end - start)) * manifest.gates.blocks),
        ) === index,
    );
    return {
      index: index + 1,
      sampleSize: blockRows.length,
      win:
        blockRows.length >= 5 &&
        blockRows.reduce(
          (sum, row) =>
            sum + row.scores["odds-plus-team"].brier - row.scores["odds-baseline"].brier,
          0,
        ) < 0 &&
        blockRows.reduce(
          (sum, row) => sum + row.scores["odds-plus-team"].brier - row.market.brier,
          0,
        ) < 0,
    };
  });
  const coverage = {
    expected: targets.size,
    captured: [...targets.keys()].filter((key) => chosen.has(key)).length,
    paired: rows.length,
    dueResults: dueKeys.length,
    resolvedDueResults: dueKeys.filter((key) => resolved.has(key)).length,
  };
  const gates = [
    { key: "window", passed: now >= end, label: "预先冻结的验证期已结束" },
    {
      key: "sample",
      passed: rows.length >= manifest.gates.minimumPairedFixtures,
      label: "至少100场去重同场配对（不保证统计独立）",
    },
    {
      key: "coverage",
      passed:
        coverage.expected > 0 &&
        coverage.captured / coverage.expected >= manifest.gates.minimumCoverage &&
        coverage.paired / coverage.expected >= manifest.gates.minimumCoverage &&
        coverage.dueResults > 0 &&
        coverage.resolvedDueResults / coverage.dueResults >= manifest.gates.minimumCoverage,
      label: "采集、完整候选与到期赛果覆盖均≥95%",
    },
    {
      key: "brier",
      passed:
        oddsInterval.delta !== null &&
        marketInterval.delta !== null &&
        oddsInterval.delta <= -manifest.gates.minimumBrierGain &&
        marketInterval.delta <= -manifest.gates.minimumBrierGain &&
        oddsInterval.upper !== null &&
        marketInterval.upper !== null &&
        oddsInterval.upper < 0 &&
        marketInterval.upper < 0,
      label: "较赔率与官方基线领先且日期块区间不跨0",
    },
    {
      key: "other-scores",
      passed:
        rows.length > 0 &&
        fused.logLoss <= Math.min(odds.logLoss, market.logLoss) &&
        fused.ece <= Math.min(odds.ece, market.ece),
      label: "Log loss与校准误差未恶化",
    },
    {
      key: "blocks",
      passed: blocks.filter((block) => block.win).length >= manifest.gates.minimumWinningBlocks,
      label: "4个预定时间区块至少3个领先",
    },
    { key: "conflicts", passed: excluded.length === 0, label: "无未解决的哈希、重放或赛果冲突" },
  ];
  return {
    status: now < start ? "scheduled" : now < end ? "collecting" : "evaluated",
    eligible: gates.every((gate) => gate.passed),
    automaticPromotion: false,
    manifest,
    sampleSize: rows.length,
    coverage,
    models,
    market,
    ablations: {
      oddsOnly: "odds-baseline",
      teamOnly: "team-only",
      fixedFusion: "odds-plus-team",
      teamWeight: manifest.teamWeight,
    },
    oddsInterval,
    marketInterval,
    blocks,
    gates,
    excluded,
    limitations: [
      "覆盖分母仅包含实际读取并保存的官方清单，源接口失败时不能证明覆盖全部销售场次",
      "球队数据缺失会降低完整候选覆盖，不以共同样本的好成绩掩盖缺失",
      "当前主指标为胜平负；半全场、伤停和xG未加入此候选验证",
      "满足门槛只允许人工审阅，不自动改变正式权重",
    ],
  };
}
