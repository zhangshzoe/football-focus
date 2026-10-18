import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVED_DOUBLING_TRIAL,
  buildPurchaseDoublingHistory,
  getApprovedDoublingTrial,
} from "../app/purchase-doubling-history.js";
import { simulatePurchaseDoubling } from "../app/purchase-doubling.js";

const method = "total-double-2";
const otherMethod = "had-safe-2";
const plan = (id = method, status = "lost", extra = {}) => ({
  id, status, passName: "2串1", stake: 8,
  simulatedReturn: status === "won" ? 20 : 0,
  items: [{ matchId: "周日001", picks: [{ pick: "2球", odd: 3 }] }],
  ...extra,
});
const batch = (date, time, plans, extra = {}) => ({
  date, scheduledTime: time,
  snapshotId: `purchase-${date}-${time.replace(":", "")}`,
  generatedAt: `${date}T${time === "21:00" ? "13" : "09"}:00:00.000Z`,
  source: "saved-capture", qualityStatus: "complete", captureTiming: "on-time",
  plans, ...extra,
});
const rows = (sets, slot = "2100", id = method) => buildPurchaseDoublingHistory(sets, slot)[id].rows;

test("21:00 wins priority regardless of either ticket's result and retains provenance", () => {
  for (const [earlyStatus, lateStatus] of [["won", "lost"], ["lost", "won"]]) {
    const early = batch("2026-10-11", "17:00", [plan(method, earlyStatus)]);
    const late = batch("2026-10-11", "21:00", [plan(method, lateStatus)]);
    const source = [late, early], before = structuredClone(source);
    const selected = rows(source);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].snapshotId, late.snapshotId);
    assert.equal(selected[0].generatedAt, late.generatedAt);
    assert.equal(selected[0].source, late.source);
    assert.deepEqual(selected[0].plan, late.plans[0]);
    assert.equal(selected[0].isFallback, false);
    assert.equal(selected[0].manualTrial, false);
    assert.deepEqual(source, before);
  }
});

test("a pending 21:00 ticket blocks the settled 17:00 ticket", () => {
  const source = [batch("2026-10-11", "17:00", [plan(method, "won")]),
    batch("2026-10-11", "21:00", [plan(method, "pending")])];
  const selected = rows(source);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].plan.status, "pending");
  assert.equal(selected[0].isFallback, false);
  const replay = simulatePurchaseDoubling(selected, method);
  assert.equal(replay.pending, 1);
  assert.equal(replay.settled, 0);
  assert.equal(replay.nextMultiplier, 1n);
});

test("explicit no-bet and malformed existing 21:00 methods block fallback even in an empty batch", () => {
  for (const unavailable of [plan(method, "unavailable", { items: [] }), plan(method, "pending", { items: [] })]) {
    const source = [batch("2026-10-11", "17:00", [plan(method, "won")]),
      batch("2026-10-11", "21:00", [unavailable])];
    assert.deepEqual(rows(source), []);
    const replay = simulatePurchaseDoubling(rows(source), method);
    assert.equal(replay.settled, 0);
    assert.equal(replay.stake, 0n);
    assert.equal(replay.nextMultiplier, 1n);
  }
});

test("only a missing definition falls back to its whole 17:00 ticket", () => {
  const early = batch("2026-10-11", "17:00", [plan(), plan(otherMethod, "won")]);
  const late = batch("2026-10-11", "21:00", [plan(otherMethod, "lost")]);
  const source = [early, late], before = structuredClone(source);
  const selected = rows(source);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].snapshotId, early.snapshotId);
  assert.equal(selected[0].generatedAt, early.generatedAt);
  assert.deepEqual(selected[0].plan, early.plans[0]);
  assert.equal(selected[0].isFallback, true);
  assert.equal(rows(source, "2100", otherMethod)[0].snapshotId, late.snapshotId);
  assert.equal(rows(source, "2100", otherMethod)[0].isFallback, false);
  assert.equal(rows(source, "1700", otherMethod)[0].snapshotId, early.snapshotId);
  assert.equal(rows(source, "1700")[0].isFallback, false);
  assert.deepEqual(source, before);
});

test("whole-batch retry selection happens before fallback, with no ticket cherry-picking", () => {
  const early = batch("2026-10-11", "17:00", [plan(method, "lost")]);
  const rejected = batch("2026-10-11", "21:00", [plan(method, "won")], {
    qualityStatus: "partial", snapshotId: "partial-retry", generatedAt: "2026-10-11T12:59:00Z",
  });
  const selected = batch("2026-10-11", "21:00", [plan(otherMethod)], { snapshotId: "complete-retry" });
  const later = batch("2026-10-11", "21:00", [plan(method, "won")], {
    snapshotId: "later-complete-retry", generatedAt: "2026-10-11T13:02:00Z",
  });
  const result = rows([later, rejected, selected, early]);
  assert.equal(result.length, 1);
  assert.equal(result[0].snapshotId, early.snapshotId);
  assert.equal(result[0].isFallback, true);
  assert.equal(result[0].plan.status, "lost");
});

test("ordinary trial/current/undated batches do not enter either cohort or change inputs", () => {
  const formal = batch("2026-10-11", "17:00", [plan()]);
  const ignored = [
    batch("2026-10-12", "17:00", [plan(method, "won")], { snapshotId: "manual-trial-unapproved" }),
    batch("2026-10-13", "18:00", [plan(method, "won")], { snapshotId: "current-unapproved" }),
    batch("", "21:00", [plan(method, "won")], { snapshotId: "undated" }),
  ];
  const source = [...ignored, formal], before = structuredClone(source);
  assert.deepEqual(rows(source).map(row => row.snapshotId), [formal.snapshotId]);
  assert.deepEqual(rows(source, "1700").map(row => row.snapshotId), [formal.snapshotId]);
  assert.deepEqual(source, before);
});

test("fallback keeps one continuous chronological doubling sequence", () => {
  const source = [batch("2026-10-11", "21:00", [plan()]),
    batch("2026-10-12", "17:00", [plan()]),
    batch("2026-10-13", "21:00", [plan(method, "won")])];
  const replay = simulatePurchaseDoubling(rows(source), method);
  assert.deepEqual(replay.rows.map(row => row.multiplier), [1n, 2n, 3n]);
  assert.deepEqual(replay.rows.map(row => row.isFallback), [false, true, false]);
  assert.equal(replay.nextMultiplier, 1n);
});

// Metadata and item shape checked against the authorized historical capture;
// this small synthetic ticket does not embed the user's archived selections.
const approvedTrial = () => ({
  snapshotId: "manual-trial-4dbbaedd-c89b-42c5-9cfe-69d4554b6b1e",
  date: "2026-10-16", generatedAt: "2026-10-16T09:19:06.549Z", scheduledTime: "17:00",
  source: "manual-research", includedInStrictEvaluation: false,
  plans: [plan(method, "pending", { items: [{
    officialMatchId: "2042010", matchId: "周五009", salesDate: "2026-10-16",
    matchStatus: "Selling", sourceFetchedAt: "2026-10-16T08:42:43.401Z",
    kickoffAt: "2026-10-17T03:00:00+08:00", cutoffAt: null, cutoffStatus: "unknown",
    picks: [{ pick: "2球", odd: 3 }],
  }] })],
});

test("the exact owner-approved research capture enters 17:00 and 21:00 fallback outside strict evaluation", () => {
  const trial = approvedTrial(), before = structuredClone(trial);
  assert.deepEqual(APPROVED_DOUBLING_TRIAL, {
    snapshotId: trial.snapshotId, date: trial.date, generatedAt: trial.generatedAt, scheduledTime: trial.scheduledTime,
  });
  const approved = getApprovedDoublingTrial(trial);
  assert.ok(approved);
  assert.notEqual(approved, trial);
  assert.equal(approved.includedInStrictEvaluation, false);
  for (const slot of ["1700", "2100"]) {
    const selected = rows([trial], slot);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].snapshotId, trial.snapshotId);
    assert.equal(selected[0].generatedAt, trial.generatedAt);
    assert.equal(selected[0].source, trial.source);
    assert.deepEqual(selected[0].plan, trial.plans[0]);
    assert.equal(selected[0].manualTrial, true);
    assert.equal(selected[0].isFallback, slot === "2100");
  }
  const formal = batch(trial.date, "17:00", [plan()]);
  assert.equal(rows([trial, formal], "1700")[0].snapshotId, formal.snapshotId);
  assert.equal(rows([trial, formal], "2100")[0].snapshotId, formal.snapshotId);
  assert.deepEqual(trial, before);
});

test("research authorization validates identity, freshness, sales state, odds and future kickoff", () => {
  for (const change of [
    trial => { trial.snapshotId += "-other"; },
    trial => { trial.generatedAt = "2026-10-16T09:20:00.000Z"; },
    trial => { trial.scheduledTime = "21:00"; },
    trial => { trial.plans[0].items[0].officialMatchId = ""; },
    trial => { trial.plans[0].items[0].salesDate = "2026-10-15"; },
    trial => { trial.plans[0].items[0].matchStatus = "Closed"; },
    trial => { trial.plans[0].items[0].sourceFetchedAt = "2026-10-16T09:20:00Z"; },
    trial => { trial.plans[0].items[0].sourceFetchedAt = "2026-10-16T08:19:06.548Z"; },
    trial => { trial.plans[0].items[0].kickoffAt = trial.generatedAt; },
    trial => { trial.plans[0].items[0].picks[0].odd = 0; },
    trial => { trial.plans[0].items[0].cutoffStatus = "known"; },
  ]) {
    const trial = approvedTrial();
    change(trial);
    assert.equal(getApprovedDoublingTrial(trial), null);
    assert.deepEqual(rows([trial], "1700"), []);
    assert.deepEqual(rows([trial], "2100"), []);
  }
});

test("previously approved manual-exception records retain their historical cohort", () => {
  const approved = batch("2026-10-12", "17:00", [plan()], {
    snapshotId: "manual-trial-previous-approval", promotionKind: "manual-exception",
  });
  assert.equal(rows([approved], "1700")[0].snapshotId, approved.snapshotId);
  assert.equal(rows([approved], "2100")[0].snapshotId, approved.snapshotId);
});

test("the existing October 9 analysis cohort keeps its specifically authorized 19:55 trial", () => {
  const early = batch("2026-10-09", "17:00", [plan(method, "won")]);
  const trial = batch("2026-10-09", "21:00", [plan(method, "lost")], {
    snapshotId: "manual-trial-private", generatedAt: "2026-10-09T11:55:30Z",
    includedInStrictEvaluation: false,
  });
  const source = [early, trial], before = structuredClone(source);
  const selected = rows(source);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].snapshotId, trial.snapshotId);
  assert.equal(selected[0].generatedAt, trial.generatedAt);
  assert.equal(selected[0].isFallback, false);
  assert.equal(rows(source, "1700")[0].snapshotId, early.snapshotId);
  assert.deepEqual(source, before);
});
