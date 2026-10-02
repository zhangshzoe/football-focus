import { decisionTargetAt } from "./snapshot-decision-policy.js";
import { purchaseCaptureWindow } from "./capture-window.js";
import { buildSnapshotOddsLayer } from "./snapshot-probability-layers.js";
import {
  resolveServerOfficialMatches,
  assertCompletePurchaseEvaluation,
} from "./server-official-evidence.js";
import { generatePurchasePlans, verifyPurchasePlanCompletion } from "./purchase-plan-engine.js";
import { collectEarlierPurchasePlans } from "./purchase-batch-policy.js";
import { buildTeamHistoryIndex } from "./team-history.js";
import {
  researchHash,
  runForwardCandidates,
  mergeFirstObservedResults,
  evaluateForwardValidation,
} from "./forward-validation.js";
import { observeResearchResults } from "./research-result-observation.js";
import { completeDistribution, EXACT_SCORE_LABELS, HAD_LABELS } from "./probability-evaluation.js";
import { validateCloudCaptureJob } from "./cloud-capture-auth.js";
import { expectedHalfFullDistribution } from "./half-full-validation.js";
import {
  appendCloudCaptureReceipt,
  recoverCloudCaptureReceipts,
  verifyCloudCaptureReceiptRecord,
  verifyCloudRawRecord,
} from "./cloud-capture-receipt.js";
import {
  buildTotalGoalsValidation,
  projectTotalGoalRawSnapshot,
  projectTotalGoalPurchase,
} from "./total-goals-validation.js";

const sourcePage = "https://cp.zgzcw.com/dc/getKaijiangFootBall.action";
const dateAt = (at) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
const slotAt = (at) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(at))
    .replace(":", "");
const fixture = (match) => ({
  officialMatchId: String(match.officialMatchId || match.matchId || ""),
  salesDate: match.salesDate,
  kickoffAt: match.kickoffAt,
  home: match.home,
  away: match.away,
  league: match.league,
});
const validVector = (values, count) =>
  Array.isArray(values) &&
  values.length === count &&
  values.every(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100,
  ) &&
  Math.abs(values.reduce((sum, value) => sum + value, 0) - 100) < 1e-5;
const complete = (report) => {
  const grid = completeDistribution(report.fullScoreDistribution, EXACT_SCORE_LABELS);
  const had = [report.probabilities?.home, report.probabilities?.draw, report.probabilities?.away];
  const total = report.marketSignal?.modeledTotalGoals,
    halfFull = report.marketSignal?.modeledHalfFull;
  const hhad = report.marketSignal?.modeledHhad,
    qualified = report.marketEligibility?.["让球胜平负"]?.qualification === "qualified";
  if (
    !grid ||
    !validVector(had, 3) ||
    !validVector(total, 8) ||
    !validVector(halfFull, 9) ||
    Math.abs(
      report.fullScoreDistribution.reduce((sum, point) => sum + point.probability, 0) - 100,
    ) > 1e-5
  )
    return false;
  const expectedHad = [0, 0, 0],
    expectedTotal = Array(8).fill(0),
    expectedHhad = [0, 0, 0];
  const line = Number(report.marketSignal?.officialHandicap);
  if (
    qualified &&
    (!Number.isInteger(line) ||
      String(report.marketSignal?.officialHandicap ?? "").trim() === "" ||
      !validVector(hhad, 3))
  )
    return false;
  EXACT_SCORE_LABELS.forEach((label, index) => {
    const [home, away] = label.split(":").map(Number),
      probability = grid[index] * 100;
    expectedHad[home > away ? 0 : home === away ? 1 : 2] += probability;
    expectedTotal[Math.min(7, home + away)] += probability;
    expectedHhad[home + line > away ? 0 : home + line === away ? 1 : 2] += probability;
  });
  const equal = (a, b) => a.every((p, index) => Math.abs(p - b[index]) < 1e-5);
  // HAFU is research-only, but all nine cells must follow the frozen model's
  // conditional split. Matching three column totals alone is insufficient.
  const expectedHalfFull = expectedHalfFullDistribution(
    report.fullScoreDistribution,
    report.modelParameters,
  );
  return (
    equal(expectedHad, had) &&
    equal(expectedTotal, total) &&
    equal(expectedHalfFull, halfFull) &&
    (!qualified || equal(expectedHhad, hhad))
  );
};
const rawReport = (report) => ({
  ...report,
  layers: {
    oddsBaseline: buildSnapshotOddsLayer(report),
    intelligenceOutput: {
      scores: [],
      coverage: 0,
      evidence: [],
      summary: report.aiEvidenceSummary || "",
      risk: "AI只提供证据，不参与概率加权",
    },
    fusionOutput: {
      fullScoreDistribution: report.fullScoreDistribution,
      probabilities: report.probabilities,
      hhad: report.marketSignal.modeledHhad || [],
      totalGoals: report.marketSignal.modeledTotalGoals,
      halfFull: report.marketSignal.modeledHalfFull,
    },
  },
  inputHash: report.inputSnapshotId,
});

// Shared-data writer: dependencies read trusted server sources. A request can
// choose a job, never submit reports, odds, observed times, model hashes or data.
export function cloudCaptureEngine(deps) {
  const {
    store,
    fetchOfficial,
    predict,
    readResults,
    appendResult,
    readResultEvents,
    bundled,
    codeHashes,
  } = deps;
  const now = deps.clock || (() => new Date().toISOString());
  const manifest = bundled.manifest;
  const historyBefore = async (startedAt) => {
    const rows = new Map(
      (bundled.teamHistory?.rows || []).map((row) => [`${row.key}|${row.contentHash}`, row]),
    );
    for await (const record of store.scan("raw")) {
      const raw = verifyCloudRawRecord(record),
        receiptRecord = await store.read(`raw-receipt-${raw.snapshotId}`);
      if (!receiptRecord) continue;
      const receipt = verifyCloudCaptureReceiptRecord(raw, receiptRecord);
      if (!receipt.executionEligible || Date.parse(receipt.persistedAt) >= Date.parse(startedAt))
        continue;
      for (const row of buildTeamHistoryIndex([record.payload]).rows) {
        const key = `${row.key}|${row.contentHash}`,
          previous = rows.get(key);
        if (!previous || Date.parse(row.observedAt) < Date.parse(previous.observedAt))
          rows.set(key, row);
      }
    }
    const selected = [...rows.values()].sort(
      (a, b) => a.key.localeCompare(b.key) || a.observedAt.localeCompare(b.observedAt),
    );
    return { rows: selected, historyVersion: researchHash(selected) };
  };
  const forward = async (raw, historyIndex, writer) => {
    const saved = [],
      excluded = [];
    if (!manifest) return { saved, excluded, status: "not-frozen" };
    for (const report of raw.reports || raw.forecasts || []) {
      try {
        const capture = runForwardCandidates({
          manifest,
          report,
          historyIndex,
          codeHashes,
          startedAt: now(),
          clock: now,
        });
        await writer.append({
          id: capture.captureId,
          type: "candidate",
          observedAt: capture.completedAt,
          payload: capture,
        });
        const persistedAt = now(),
          receipt = {
            recordType: "forward-capture-receipt",
            immutable: true,
            captureId: capture.captureId,
            contentHash: capture.contentHash,
            rawSnapshotId: raw.snapshotId,
            persistedAt,
          };
        await writer.append({
          id: `receipt-${capture.captureId}`,
          type: "receipt",
          observedAt: persistedAt,
          payload: receipt,
        });
        saved.push(capture.captureId);
      } catch (error) {
        if (error.code === "CLOUD_LEASE_LOST") throw error;
        excluded.push({ officialMatchId: report.officialMatchId, reason: error.message });
      }
    }
    return { status: "checked", saved, excluded };
  };
  const replay = async (writer) => {
    await writer.assertLease();
    const receipts = new Map(
      (await store.list("receipt"))
        .filter((record) => record.payload.recordType === "forward-capture-receipt")
        .map((record) => [record.payload.captureId, record.payload]),
    );
    const captures = [...(bundled.captures || [])];
    for await (const record of store.scan("candidate")) {
      const receipt = receipts.get(record.payload.captureId);
      if (receipt?.contentHash === record.payload.contentHash)
        captures.push({ ...record.payload, persistedAt: receipt.persistedAt });
    }
    const universeByHash = new Map(
      (bundled.fixtureUniverse || []).map((row) => [researchHash(row), row]),
    );
    for await (const record of store.scan("official-universe"))
      for (const row of record.payload.fixtures) universeByHash.set(researchHash(row), row);
    const universe = [...universeByHash.values()];
    const merged = mergeFirstObservedResults(
      [...(bundled.resultEvents || []), ...(await readResultEvents())],
      { now: Date.parse(now()) },
    );
    const invalidResultEvents = [...(bundled.invalidResultEvents || []), ...merged.invalid];
    const evaluatedAt = now();
    const observedDates = new Set(universe.map((row) => row.salesDate));
    const missingSourceDates = [];
    if (manifest)
      for (
        let at = Date.parse(manifest.startAt);
        at < Math.min(Date.parse(manifest.endAt), Date.parse(evaluatedAt));
        at += 86400000
      ) {
        const date = dateAt(at);
        if (!observedDates.has(date)) missingSourceDates.push(date);
      }
    const evaluation = invalidResultEvents.length
      ? { status: "result-integrity-failed", eligible: false, sampleSize: 0, invalidResultEvents }
      : manifest && researchHash(codeHashes) !== researchHash(manifest.codeHashes)
        ? {
            status: "implementation-changed",
            eligible: false,
            sampleSize: 0,
            reason: "冻结候选实现已变化，需新建未来版本",
          }
        : evaluateForwardValidation({
            manifest,
            captures,
            resultEvents: merged.records,
            fixtureUniverse: universe,
            now: Date.parse(evaluatedAt),
          });
    // A source outage cannot remove a day from the denominator and manufacture
    // 100% coverage. Unknown days suspend eligibility, with no invented count.
    if (missingSourceDates.length)
      Object.assign(evaluation, {
        status: "official-coverage-unknown",
        eligible: false,
        missingSourceDates,
        officialCoverageKnown: false,
        reason: "部分销售日缺少成功读取的完整官方清单，真实总场数未知",
      });
    const totalObservations = [...(bundled.totalGoalsIndex?.observations || [])],
      totalPurchases = [...(bundled.totalGoalsIndex?.purchases || [])];
    for (const type of ["raw", "purchase"])
      for await (const record of store.scan(type)) {
        await writer.assertLease();
        const raw = verifyCloudRawRecord(record),
          receiptRecord = await store.read(`raw-receipt-${raw.snapshotId}`);
        const receipt = receiptRecord ? verifyCloudCaptureReceiptRecord(raw, receiptRecord) : null;
        totalObservations.push(...projectTotalGoalRawSnapshot(raw, receipt));
        if (type === "purchase") totalPurchases.push(projectTotalGoalPurchase(raw, receipt));
      }
    const sourceAttempts = [...(await store.list("source-attempt"))].map(
      (record) => record.payload,
    );
    const totalGoalsValidation = buildTotalGoalsValidation({
      observations: totalObservations,
      purchases: totalPurchases,
      resultEvents: merged.records,
      fixtureUniverse: universe,
      sourceAttempts,
      now: Date.parse(evaluatedAt),
    });
    const data = {
      schemaVersion: 1,
      manifest,
      captureCount: captures.length,
      captureReceipts: captures.map(({ captureId, contentHash, persistedAt }) => ({
        captureId,
        contentHash,
        persistedAt,
      })),
      fixtureUniverse: universe,
      resultEvents: merged.records,
      invalidResultEvents,
      implementationHashes: codeHashes,
      evaluation,
      totalGoalsValidation,
      evaluatedAt,
    };
    const id = `replay-${researchHash(data)}`;
    await writer.append({ id, type: "replay-index", observedAt: evaluatedAt, payload: data });
    return {
      status: "replayed",
      replayId: id,
      sampleSize: evaluation.sampleSize,
      eligible: evaluation.eligible,
    };
  };
  const execute = async (job) => {
    validateCloudCaptureJob(job);
    const startedAt = now(),
      requestHash = researchHash(job);
    const claimed = await store.claim({ id: job.requestId, requestHash, startedAt });
    if (!claimed.claimed) return claimed.result || { status: "running", requestId: job.requestId };
    const writer = store.withLease(claimed.lease);
    const predictionController = new AbortController();
    let renewal = Promise.resolve(),
      renewalError;
    const heartbeat = setInterval(() => {
      renewal = renewal
        .then(() => store.renew(claimed.lease))
        .catch((error) => {
          renewalError = error;
          predictionController.abort(error);
        });
    }, 40000);
    try {
      const date = dateAt(startedAt),
        audit = {
          recordType: "cloud-source-attempt",
          immutable: true,
          requestId: job.requestId,
          salesDate: date,
          kind: job.action,
          slot: job.slot || "poll",
          startedAt,
          scheduledAt: null,
          actualAttemptAt: startedAt,
          officialManifest: null,
          stage: "starting",
          storageOrigin: "cloud",
        };
      let outcome;
      try {
        audit.stage = "receipt-recovery";
        audit.recoveredReceipts = await recoverCloudCaptureReceipts(writer, now);
        if (job.action === "replay") outcome = await replay(writer);
        else if (job.action === "results") {
          const queryDate = job.date || dateAt(Date.parse(startedAt) - 86400000);
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(queryDate) ||
            queryDate > date ||
            queryDate < dateAt(Date.parse(startedAt) - 29 * 86400000)
          )
            throw new Error("赛果查询日期超出允许范围");
          const universe = [
            ...(bundled.fixtureUniverse || []),
            ...(bundled.captures || []).map((capture) => capture.fixture),
          ];
          for await (const record of store.scan("official-universe"))
            universe.push(...record.payload.fixtures);
          audit.stage = "result-source";
          const data = await readResults(queryDate);
          const observation = observeResearchResults({
            results: data.results,
            fixtureUniverse: universe,
            manifest,
            observedAt: data.fetchedAt,
            sourcePage,
          });
          for (const record of observation.records) await appendResult(record, claimed.lease);
          outcome = {
            status: "results-observed",
            date: queryDate,
            saved: observation.records.length,
            rejected: observation.rejected,
          };
        } else {
          if (job.action === "purchase") {
            const window = purchaseCaptureWindow(date, job.slot, Date.parse(startedAt), true);
            audit.scheduledAt = `${date}T${job.slot === "2100" ? "21:00" : "17:00"}:00+08:00`;
            if (!window.allowed) {
              outcome = { status: "skipped", reason: window.reason };
            } else if (
              (bundled.purchaseSnapshots || []).some(
                (record) => record.immutable && record.scheduledAt === audit.scheduledAt,
              ) ||
              (await store.read(`purchase-${date}-${job.slot}`))
            )
              outcome = { status: "skipped", reason: "daily-snapshot-exists" };
          }
          if (!outcome) {
            audit.stage = "official-source";
            const official = await fetchOfficial();
            if (
              !official.poolStatus ||
              ["HAD", "HHAD", "CRS", "TTG", "HAFU"].some(
                (pool) => official.poolStatus[pool]?.status !== "success",
              )
            )
              throw new Error("官方五玩法清单未全部读取成功，覆盖范围未知");
            const matches = (official.matches || []).filter((match) => match.salesDate === date);
            if (
              !matches.length ||
              matches.some(
                (match) =>
                  !/^\d+$/.test(String(match.officialMatchId || match.matchId)) ||
                  match.isMock ||
                  !Number.isFinite(Date.parse(match.kickoffAt)),
              )
            )
              throw new Error("官方清单为空或真实赛事身份不完整");
            const sourceTime = Date.parse(official.fetchedAt),
              checkedAt = Date.parse(now());
            if (
              !Number.isFinite(sourceTime) ||
              sourceTime > checkedAt ||
              checkedAt - sourceTime > 300000
            )
              throw new Error("官方数据采集时刻无效或过期");
            audit.officialManifest = matches.map(fixture);
            audit.sourceFetchedAt = official.fetchedAt;
            await writer.append({
              id: `universe-${job.requestId}-${claimed.lease.fence}`,
              type: "official-universe",
              observedAt: official.fetchedAt,
              payload: {
                recordType: "official-fixture-universe",
                immutable: true,
                salesDate: date,
                fetchedAt: official.fetchedAt,
                upstreamUpdatedAt: official.upstreamUpdatedAt,
                fixtures: audit.officialManifest,
              },
            });
            const due = [];
            for (const match of matches) {
              const target = decisionTargetAt(date, match.kickoffAt),
                targetMs = Date.parse(target);
              if (
                job.action === "purchase" ||
                (checkedAt >= targetMs - 15 * 60000 &&
                  checkedAt <= targetMs &&
                  checkedAt < Date.parse(match.kickoffAt))
              ) {
                const id = `raw-${date}-${slotAt(target)}-${match.officialMatchId || match.matchId}`;
                if (job.action === "purchase" || !(await store.read(id))) due.push(match);
              }
            }
            if (!due.length)
              outcome = {
                status: "skipped",
                reason: "no-due-fixtures",
                officialFixtureCount: matches.length,
              };
            else {
              audit.stage = "prediction-validation";
              const historyIndex = await historyBefore(startedAt);
              await writer.assertLease();
              const deadlineMs =
                job.action === "purchase"
                  ? purchaseCaptureWindow(date, job.slot, Date.parse(now()), true).end
                  : Math.min(
                      ...due.map((match) => Date.parse(decisionTargetAt(date, match.kickoffAt))),
                    );
              const predictions = await predict(
                due.map((match) => String(match.officialMatchId || match.matchId)),
                {
                  signal: predictionController.signal,
                  deadlineMs,
                },
              );
              predictionController.signal.throwIfAborted();
              await writer.assertLease();
              const verifiedMatches = resolveServerOfficialMatches(
                predictions,
                due,
                date,
                Date.parse(now()),
              );
              const reports = (predictions.reports || []).map(rawReport);
              if (
                reports.some((report) => {
                  const match = verifiedMatches.find(
                    (row) =>
                      String(row.officialMatchId || row.matchId) === String(report.officialMatchId),
                  );
                  if (
                    match?.marketEligibility?.["让球胜平负"]?.qualification === "qualified" &&
                    (report.marketEligibility?.["让球胜平负"]?.qualification !== "qualified" ||
                      Number(report.marketSignal?.officialHandicap) !== Number(match.handicap) ||
                      Number(report.modelInput?.official?.handicap) !== Number(match.handicap))
                  )
                    return true;
                  return !complete(report);
                })
              )
                throw new Error("正式留档缺少完整一致的五玩法分布");
              if (job.action === "purchase") {
                if (!reports.length) throw new Error("没有通过官方映射校验的预测");
                const earlierSets = (bundled.purchaseSnapshots || []).map((record) => ({
                  ...record.planSet,
                  snapshotId: record.snapshotId,
                }));
                for await (const record of store.scan("purchase")) {
                  const raw = verifyCloudRawRecord(record),
                    receiptRecord = await store.read(`raw-receipt-${raw.snapshotId}`);
                  if (
                    receiptRecord &&
                    verifyCloudCaptureReceiptRecord(raw, receiptRecord).executionEligible
                  )
                    earlierSets.push({
                      ...record.payload.planSet,
                      snapshotId: record.payload.snapshotId,
                    });
                }
                const earlier = collectEarlierPurchasePlans(earlierSets, date);
                if (job.slot === "2100" && earlier.status !== "verified")
                  throw new Error("17:00正式批次或不投注记录缺失，无法核验全天限额");
                const inputDecisionAt = now();
                const planSet = generatePurchasePlans({
                  date,
                  reports,
                  officialMatches: verifiedMatches,
                  generatedAt: inputDecisionAt,
                  priorPlans: job.slot === "2100" ? earlier.plans : [],
                });
                assertCompletePurchaseEvaluation(planSet);
                const capturedAt = now(),
                  window = purchaseCaptureWindow(date, job.slot, Date.parse(capturedAt), true);
                if (!window.allowed) throw new Error("采集完成已超过批次截止时刻");
                verifyPurchasePlanCompletion(planSet, verifiedMatches, capturedAt);
                Object.assign(planSet, {
                  scheduledTime: job.slot === "2100" ? "21:00" : "17:00",
                  inputDecisionAt,
                  generatedAt: capturedAt,
                  completedAt: capturedAt,
                  source: "线上真实官方赔率 · 实际采集批次",
                });
                const snapshotId = `purchase-${date}-${job.slot}`,
                  record = {
                    schemaVersion: 2,
                    recordType: "purchase-plan-snapshot",
                    immutable: true,
                    snapshotId,
                    scheduledAt: audit.scheduledAt,
                    capturedAt,
                    calculationCompletedAt: capturedAt,
                    inputDecisionAt,
                    decisionTiming: "pending-readback",
                    sourceFetchedAt: predictions.officialSource.fetchedAt,
                    officialSource: predictions.officialSource,
                    upstreamUpdatedAt: predictions.officialSource.upstreamUpdatedAt,
                    officialMatches: verifiedMatches,
                    forecasts: reports,
                    predictionVersion: predictions.version,
                    predictionId: predictions.predictionId,
                    inputHash: predictions.version?.inputSnapshotId,
                    contentHash: researchHash(planSet),
                    planSet,
                  };
                await writer.append({
                  id: snapshotId,
                  type: "purchase",
                  observedAt: capturedAt,
                  payload: record,
                });
                const receipt = await appendCloudCaptureReceipt(writer, record, now());
                outcome = {
                  status: receipt.executionEligible ? "saved" : "retained-for-audit",
                  snapshotIds: [snapshotId],
                  timing: receipt.decisionTiming,
                  executionEligible: receipt.executionEligible,
                  reason: receipt.executionReason,
                  forwardResearch: receipt.includedInStrictEvaluation
                    ? await forward({ ...record, reports }, historyIndex, writer)
                    : { status: "excluded-completion", saved: [] },
                };
              } else {
                const saved = [],
                  excluded = [];
                for (const report of reports) {
                  const target = decisionTargetAt(date, report.kickoffAt),
                    capturedAt = now();
                  // Late work is evidence of a late attempt, never a strict input.
                  if (
                    Date.parse(capturedAt) > Date.parse(target) ||
                    Date.parse(capturedAt) >= Date.parse(report.kickoffAt)
                  ) {
                    excluded.push({
                      officialMatchId: report.officialMatchId,
                      reason: "completed-after-decision",
                    });
                    continue;
                  }
                  const decisionMs = Date.parse(report.modelInput?.decisionAt || "");
                  if (
                    !Number.isFinite(decisionMs) ||
                    decisionMs < Date.parse(target) - 15 * 60000 ||
                    decisionMs > Date.parse(capturedAt)
                  ) {
                    excluded.push({
                      officialMatchId: report.officialMatchId,
                      reason: "outside-actual-decision-window",
                    });
                    continue;
                  }
                  const snapshotId = `raw-${date}-${slotAt(target)}-${report.officialMatchId}`;
                  const raw = {
                    schemaVersion: 3,
                    recordType: "raw-prediction-snapshot",
                    snapshotId,
                    immutable: true,
                    scheduledAt: target,
                    scheduledTime: slotAt(target),
                    capturedAt,
                    calculationCompletedAt: capturedAt,
                    sourceFetchedAt: predictions.officialSource.fetchedAt,
                    officialSource: predictions.officialSource,
                    upstreamUpdatedAt: predictions.officialSource.upstreamUpdatedAt,
                    captureTiming: "pending-readback",
                    decisionTiming: "pending-readback",
                    officialMatches: verifiedMatches.filter(
                      (match) =>
                        String(match.officialMatchId || match.matchId) === report.officialMatchId,
                    ),
                    version: predictions.version,
                    predictionId: predictions.predictionId,
                    inputHash: report.inputSnapshotId,
                    reports: [report],
                  };
                  await writer.append({
                    id: snapshotId,
                    type: "raw",
                    observedAt: capturedAt,
                    payload: raw,
                  });
                  const receipt = await appendCloudCaptureReceipt(writer, raw, now());
                  saved.push({
                    snapshotId,
                    timing: receipt.decisionTiming,
                    executionEligible: receipt.executionEligible,
                    forwardResearch: receipt.includedInStrictEvaluation
                      ? await forward(raw, historyIndex, writer)
                      : { status: "excluded-completion", saved: [] },
                  });
                }
                outcome = {
                  status: saved.length ? "saved" : "skipped",
                  reason: saved.length ? null : "no-verified-on-time-reports",
                  records: saved,
                  excluded,
                  officialFixtureCount: matches.length,
                  mappedFixtureCount: reports.length,
                };
              }
            }
          }
        }
      } catch (error) {
        if (error.code === "CLOUD_LEASE_LOST") throw error;
        if (
          [
            "OFFICIAL_ACCESS_BLOCKED",
            "OFFICIAL_MANIFEST_UNAVAILABLE",
            "OFFICIAL_FETCH_FAILED",
          ].includes(error.code)
        )
          Object.assign(audit, {
            sourceCode: error.code,
            sourceState: error.sourceState || { manifestState: "unknown" },
          });
        outcome = { status: "failed", reason: error.message };
      }
      if (
        outcome.status !== "failed" &&
        job.action !== "replay" &&
        (audit.officialManifest || job.action === "results")
      ) {
        try {
          outcome.index = await replay(writer);
        } catch (error) {
          if (error.code === "CLOUD_LEASE_LOST") throw error;
          outcome.index = { status: "failed", reason: error.message };
        }
      }
      const completedAt = now();
      Object.assign(audit, {
        completedAt,
        status: outcome.status,
        reason: outcome.reason || null,
        outcome: outcome.timing === "delayed-batch" ? "late" : outcome.status,
        result: outcome,
      });
      if (renewalError) throw renewalError;
      const attemptId = `attempt-${job.requestId}-${claimed.lease.fence}`;
      await writer.append({
        id: attemptId,
        type: "source-attempt",
        observedAt: completedAt,
        payload: audit,
      });
      return await writer.complete(job.requestId, {
        ...outcome,
        requestId: job.requestId,
        attemptId,
        completedAt,
      });
    } finally {
      predictionController.abort(new Error("采集等待已结束"));
      clearInterval(heartbeat);
      await renewal;
      await store.release(claimed.lease);
    }
  };
  return { execute };
}
