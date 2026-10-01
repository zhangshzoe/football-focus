import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCompany } from "../app/prediction-input.js";
import { predictFromSnapshot, PREDICTION_PIPELINE_VERSION } from "../app/prediction-model.js";
import { buildFirstObservedResult, researchHash } from "../app/forward-validation.js";
import { cloudCaptureReceipt } from "../app/cloud-capture-receipt.js";
import { projectTotalGoalRawSnapshot, buildTotalGoalsValidation } from "../app/total-goals-validation.js";
import { appendLocalCaptureReceipt, readLocalCaptureReceipt } from "../scripts/local-capture-receipts.mjs";
import ts from "typescript";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";

// Synthetic data stays in test memory or OS temp, never real history directories.
const at = "2026-09-29T13:25:00Z", completed = "2026-09-29T13:25:01Z", now = Date.parse("2026-10-01T00:00:00Z");
const odds = [16, 8, 3.2, 4, 8, 16, 32, 32];
function source(ids = ["1001"], parameters = {}, time = at, schedule = "2026-09-29T13:30:00Z") {
  const match = (id) => ({ officialMatchId: id, salesDate: "2026-09-29", kickoffAt: "2026-09-29T14:00:00Z",
    home: `Home-${id}`, away: `Away-${id}`, matchStatus: "Selling", marketOdds: { "总进球数": odds },
    marketEligibility: { "总进球数": { qualification: "qualified", salesStatus: "Selling", allowedPassCounts: [1, 2, 3], cutoffAt: "2026-09-29T14:00:00Z" } } });
  const officialMatches = ids.map(match);
  const reports = officialMatches.map((fixture) => {
    const modelInput = { schemaVersion: 1, pipelineVersion: PREDICTION_PIPELINE_VERSION, decisionAt: time,
      companies: [2, 3].map((id) => normalizeCompany({ SOURCE_COMPANY_ID: id, WIN: 2, SAME: 3.5, LOST: 4,
        HANDICAP: -.25, HOST: .9, GUEST: .9, DW_HANDICAP: 2.5, BIG: .9, SMALL: .9 }, time)),
      official: { ...fixture, fetchedAt: time, totalOdds: odds, hadOdds: [2, 3.5, 4], hhadOdds: [2, 3.5, 4], handicap: -1, scoreOdds: [], halfFullOdds: [] } };
    return { ...fixture, officialMappingStatus: "verified", modelInput, modelParameters: parameters,
      calibrationVersion: "test-identity-calibration", inputSnapshotId: "test-input-hash",
      predictionGeneratedAt: time, sourceFetchedAt: time,
      marketSignal: { modeledTotalGoals: predictFromSnapshot(modelInput, parameters).totalGoalProbabilities } };
  });
  return { recordType: "raw-prediction-snapshot", immutable: true, snapshotId: `batch-${time}-${ids.join("-")}`,
    scheduledAt: schedule, capturedAt: time, sourceFetchedAt: time, officialMatches, reports,
    officialSource: { manifestState: "complete", poolStatus: Object.fromEntries(["HAD", "HHAD", "CRS", "TTG", "HAFU"].map((pool) => [pool, { status: "success", observedAt: time }])) } };
}
function observations(raw, receiptAt = new Date(Date.parse(raw.capturedAt) + 1000).toISOString()) { return projectTotalGoalRawSnapshot(raw, cloudCaptureReceipt(raw, receiptAt)); }
function event(raw, index = 0, fullScore = "2:0") {
  const fixture = raw.officialMatches[index], [home, away] = fullScore.split(":").map(Number);
  const value = buildFirstObservedResult({ ...fixture, status: "settled", fullScore,
    hadResult: home > away ? "胜" : home === away ? "平" : "负", totalGoalsResult: home + away >= 7 ? "7+" : String(home + away) },
    [fixture], "2026-09-29T16:00:00Z", "https://cp.zgzcw.com/dc/getKaijiangFootBall.action");
  assert.equal(value.status, "verified", value.reason); return value.record;
}
const build = (obs, events, extra = {}) => buildTotalGoalsValidation({ observations: obs, resultEvents: events, now, ...extra });

test("TTG uses verified replay, complete 8 classes, paired metrics and sparse null intervals", () => {
  const raw = source(), report = build(observations(raw), [event(raw)]), summary = report.cohorts[0].windows.all;
  assert.equal(report.comparableMatches, 1); assert.equal(report.promotionEligible, false);
  assert.equal(report.labels.length, 8); assert.equal(summary.model.sampleSize, summary.market.sampleSize);
  // Independent arithmetic from quoted SP, not the implementation's summary helper.
  const inverse = odds.map((o) => 1 / o), sum = inverse.reduce((a, b) => a + b), market = inverse.map((p) => p / sum);
  const brier = market.reduce((v, p, i) => v + (p - Number(i === 2)) ** 2, 0);
  assert.ok(Math.abs(summary.market.brier - brier) < 1e-12);
  assert.ok(Math.abs(summary.market.logLoss + Math.log(market[2])) < 1e-12);
  let cumulative = 0, rps = 0; market.slice(0, 7).forEach((p, i) => { cumulative += p; rps += (cumulative - Number(i >= 2)) ** 2 / 7; });
  assert.ok(Math.abs(summary.market.rps - rps) < 1e-12);
  assert.equal(summary.market.top2, 1); assert.equal(summary.differences.brier.lower, null);
  assert.equal(build(observations(raw), [event(raw, 0, "8:0")]).rows[0].actual, 7);
});

test("latest valid target is selected before outcomes/version eligibility, in either order", () => {
  const early = source(), late = source(["1001"], {}, "2026-09-29T13:29:00Z");
  late.reports[0].modelInput.pipelineVersion = "old-version";
  const old = observations(early), newer = observations(late, "2026-09-29T13:29:01Z");
  for (const input of [[...old, ...newer], [...newer, ...old]]) {
    const report = build(input, [event(early)]); assert.equal(report.comparableMatches, 0);
    assert.equal(report.exclusions["incompatible-raw-version"], 1); assert.equal(report.exclusions["superseded-before-target"], 1);
  }
  const after = source(["1001"], {}, "2026-09-29T13:31:00Z");
  const report = build([...old, ...observations(after, "2026-09-29T13:31:01Z")], [event(early)]);
  assert.equal(report.comparableMatches, 1); assert.equal(report.exclusions["after-fixed-decision"], 1);
});

test("completion, recovery, quote freshness and stored replay proof cannot be invented", () => {
  const raw = source();
  const missing = build(projectTotalGoalRawSnapshot(raw, null), [event(raw)]);
  assert.equal(missing.exclusions["missing-verified-completion"], 1);
  const recovered = projectTotalGoalRawSnapshot(raw, cloudCaptureReceipt(raw, completed, { recovered: true }));
  assert.equal(build(recovered, [event(raw)]).comparableMatches, 0);
  const delayed = build(observations(raw, "2026-09-29T13:30:01Z"), [event(raw)]);
  assert.equal(delayed.comparableMatches, 0);
  for (const change of [
    (r) => { r.reports[0].modelInput.official.officialMatchId = "wrong"; },
    (r) => { r.officialSource.poolStatus.TTG.observedAt = "2026-09-29T13:19:00Z"; },
    (r) => { r.reports[0].marketSignal.modeledTotalGoals.pop(); },
    (r) => { r.reports[0].marketSignal.modeledTotalGoals[0] += .01; r.reports[0].marketSignal.modeledTotalGoals[1] -= .01; },
    (r) => { r.reports[0].modelInput.official.totalOdds.pop(); },
  ]) { const altered = structuredClone(raw); change(altered); assert.equal(build(observations(altered), [event(raw)]).comparableMatches, 0); }
});

test("same pipeline different parameter fingerprints stay separate and results never fill missing evidence", () => {
  const one = source(["1001"]), two = source(["1002"], { temperature: 1.1 });
  const report = build([...observations(one), ...observations(two)], [event(one), event(two)]);
  assert.equal(report.cohorts.length, 2); assert.equal(report.cohorts[0].windows.all.sampleSize, 1);
  const conflict = build(observations(one), [event(one), event(one, 0, "1:1")]);
  assert.equal(conflict.exclusions["conflicting-verified-results"], 1);
  const pending = build(observations(one), [{ ...event(one), contentHash: "tampered" }]);
  assert.equal(pending.comparableMatches, 0); assert.equal(pending.invalidResultEvents, 1);
  assert.equal(pending.exclusions["pending-verified-result"], 1);
  const same = build([...observations(one), ...observations(one)], [event(one), event(one)]);
  assert.equal(same.comparableMatches, 1);
});

function purchase(raw) {
  const items = raw.reports.map((r) => {
    const selected = r.marketSignal.modeledTotalGoals.map((p, i) => ({ p, i })).sort((a, b) => b.p - a.p || a.i - b.i).slice(0, 2);
    return { officialMatchId: r.officialMatchId, salesDate: r.salesDate, market: "total",
      picks: selected.map(({ p, i }) => ({ pick: i === 7 ? "7+球" : `${i}球`, odd: odds[i], probability: p })) };
  });
  raw.recordType = "purchase-plan-snapshot"; raw.forecasts = raw.reports; delete raw.reports;
  raw.planSet = { plans: [{ id: "actual-saved-ticket", status: "pending", items, stake: 2 * 2 ** items.length, betCount: 2 ** items.length }] };
  return { snapshotId: raw.snapshotId, scheduledAt: raw.scheduledAt, capturedAt: new Date(Date.parse(raw.capturedAt) + 1000).toISOString(), planSet: raw.planSet };
}

test("saved ticket counterfactual fixes games/stake, rounds whole units, excludes missing or altered picks", () => {
  const raw = source(["1001", "1002"], {}, "2026-09-29T12:55:00Z", "2026-09-29T13:00:00Z"), saved = purchase(raw), obs = observations(raw);
  const outcomes = raw.forecasts.map((_, i) => event(raw, i));
  const report = build(obs, outcomes, { purchases: [saved, saved] });
  assert.equal(report.tickets.sampleSize, 1); assert.equal(report.tickets.exclusions["duplicate-saved-ticket"], 1);
  assert.equal(report.tickets.rows[0].market.stake, 8); assert.equal(report.tickets.rows[0].market.returned, 20.48);
  assert.equal(report.tickets.rows[0].market.netProfit, 12.48);
  assert.equal(build(obs, outcomes.slice(0, 1), { purchases: [saved] }).tickets.sampleSize, 0);
  const changed = structuredClone(saved); changed.planSet.plans[0].items[0].picks[0].odd += .1;
  assert.equal(build(obs, outcomes, { purchases: [changed] }).tickets.sampleSize, 0);
  const three = source(["1001", "1002", "1003"], {}, "2026-09-29T12:55:00Z", "2026-09-29T13:00:00Z"), saved3 = purchase(three);
  const report3 = build(observations(three), three.forecasts.map((_, i) => event(three, i)), { purchases: [saved3] });
  assert.equal(report3.tickets.rows[0].market.stake, 16); assert.equal(report3.tickets.rows[0].market.returned, 65.54);
  const inventedSource = source(["1001", "1002"]);
  const invented = { ...saved, snapshotId: inventedSource.snapshotId };
  assert.equal(build(observations(inventedSource), outcomes, { purchases: [invented] }).tickets.sampleSize, 0);
  const unavailable = structuredClone(raw); unavailable.planSet.plans[0].status = "unavailable";
  assert.equal(build(observations(unavailable), outcomes, { purchases: [{ ...saved, planSet: unavailable.planSet }] }).tickets.sampleSize, 0);
  const modifiedRaw = structuredClone(raw); modifiedRaw.planSet.plans[0].id = "changed-original";
  const conflicting = build([...obs, ...observations(modifiedRaw)], outcomes, { purchases: [saved] });
  assert.equal(conflicting.tickets.sampleSize, 0); assert.equal(conflicting.comparableMatches, 0);
});

test("empty source stays unavailable, not 0% or full coverage", () => {
  const report = build([], [], { fixtureUniverse: source().officialMatches, sourceAttempts: [{ outcome: "failed", completedAt: completed, officialManifest: [], reason: "source unknown" }] });
  assert.equal(report.status, "no-comparable-samples"); assert.equal(report.latestSourceStatus, "failed");
  assert.equal(report.officialUniverseKnown, false); assert.equal(report.cohorts.length, 0);
  assert.equal(report.tickets.groups.length, 0);
});

test("whole-ticket cash cannot bypass actual generation time or invent a batch completion time", () => {
  const raw = source(["1001", "1002"], {}, "2026-09-29T12:55:00Z", "2026-09-29T13:00:00Z"), saved = purchase(raw);
  const outcomes = raw.forecasts.map((_, i) => event(raw, i));
  for (const changedAt of [null, new Date(now + 1000).toISOString(), "2026-09-29T12:54:00Z"]) {
    const changed = structuredClone(raw); changed.forecasts.forEach((report) => { report.predictionGeneratedAt = changedAt; });
    const report = build(observations(changed), outcomes, { purchases: [saved] });
    assert.equal(report.comparableMatches, 0); assert.equal(report.tickets.sampleSize, 0);
    assert.equal(report.tickets.exclusions["missing-or-invalid-real-times"], 1);
  }
  const inventedTime = { ...saved, capturedAt: "2026-09-29T13:00:00Z" };
  const report = build(observations(raw), outcomes, { purchases: [inventedTime] });
  assert.equal(report.tickets.sampleSize, 0);
  assert.equal(report.tickets.exclusions["saved-ticket-provenance-mismatch"], 1);
});

test("local completion receipts read back exact raw bytes, create once and never backfill old raw", async () => {
  const root = await mkdtemp(join(tmpdir(), "football-ttg-receipt-")), raw = source(), path = join(root, "raw.json");
  try {
    await writeFile(path, JSON.stringify(raw));
    assert.equal(await readLocalCaptureReceipt(raw, root), null);
    const receipt = await appendLocalCaptureReceipt(raw, path, root, () => completed);
    assert.equal(receipt.rawHash, researchHash(raw)); assert.equal(receipt.persistedAt, completed);
    await assert.rejects(appendLocalCaptureReceipt(raw, path, root, () => completed), { code: "EEXIST" });
    const altered = structuredClone(raw); altered.reports[0].inputSnapshotId = "changed";
    await assert.rejects(readLocalCaptureReceipt(altered, root), /不一致/);
    assert.deepEqual(JSON.parse(await readFile(path)), raw);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("dedicated panel renders honest empty data, paired metrics and collapse/window controls", async () => {
  const sourceText = await readFile(new URL("../app/components/TotalGoalsValidationPanel.tsx", import.meta.url), "utf8");
  const js = ts.transpileModule(sourceText, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/from "(react(?:\/jsx-runtime)?)"/g, (_, name) => `from ${JSON.stringify(import.meta.resolve(name))}`)
    .replace('from "../total-goals-validation-contract.js"', `from ${JSON.stringify(new URL("../app/total-goals-validation-contract.js", import.meta.url).href)}`);
  const { default: Panel } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost.test" });
  const prior = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } = await import("react-dom/client");
  const mount = dom.window.document.querySelector("#root"), root = createRoot(mount);
  let current = build([], []);
  globalThis.fetch = async () => new Response(JSON.stringify({ report: current }));
  try {
    await act(async () => { root.render(createElement(Panel)); });
    assert.match(mount.textContent, /暂无合格.*不是0%/);
    assert.match(mount.textContent, /不使用手动赛果/);
    assert.equal(mount.querySelector("details.total-goals-validation").open, true);
    await act(async () => { root.render(null); });
    const raw = source(); current = build(observations(raw), [event(raw)]);
    await act(async () => { root.render(createElement(Panel)); });
    assert.match(mount.textContent, /单场Top2覆盖率/);
    assert.match(mount.textContent, /样本不足不报区间/);
    assert.equal(mount.querySelectorAll(".ttg-validation-metrics article").length, 2);
    const all = [...mount.querySelectorAll("button")].find((b) => b.textContent === "全部");
    await act(async () => { all.click(); });
    assert.equal(all.getAttribute("aria-pressed"), "true");
    await act(async () => { root.render(null); });
    current = structuredClone(current); delete current.tickets.groups;
    await act(async () => { root.render(createElement(Panel)); });
    assert.match(mount.textContent, /格式不可核验/);
    assert.equal(mount.querySelectorAll(".ttg-validation-metrics article").length, 0);
  } finally {
    await act(async () => { root.unmount(); }); dom.window.close();
    globalThis.window = prior.window; globalThis.document = prior.document;
    globalThis.fetch = prior.fetch; globalThis.IS_REACT_ACT_ENVIRONMENT = prior.act;
  }
});

test("diagnostic read contract rejects corrupt groups, nonfinite metrics and false paired denominators", async () => {
  const { isTotalGoalsValidationReport: valid } = await import("../app/total-goals-validation-contract.js");
  const raw = source(), report = build(observations(raw), [event(raw)]);
  assert.equal(valid(report), true);
  assert.equal(valid(build([], [])), true);
  const missing = structuredClone(report); delete missing.tickets.groups; assert.equal(valid(missing), false);
  const incompatible = structuredClone(report); incompatible.validationVersion = "unknown"; assert.equal(valid(incompatible), false);
  const corrupt = structuredClone(report); corrupt.cohorts[0].windows.all.model.brier = Infinity; assert.equal(valid(corrupt), false);
  const unpaired = structuredClone(report); unpaired.cohorts[0].windows.all.market.sampleSize++; assert.equal(valid(unpaired), false);
  const incorrectDelta = structuredClone(report); incorrectDelta.cohorts[0].windows.all.differences.brier.delta += 1; assert.equal(valid(incorrectDelta), false);
});
