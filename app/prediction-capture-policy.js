import { decisionTargetAt } from "./snapshot-decision-policy.js";
import { resolveServerOfficialMatches } from "./server-official-evidence.js";
import { cloudCaptureReceipt } from "./cloud-capture-receipt.js";
import { completePredictionDistribution } from "./prediction-distribution-validation.js";
import { MARKET_META } from "./purchase-plan-engine.js";

const WINDOW_MS = 15 * 60000;
const idOf = (match) => String(match.officialMatchId || match.matchId || "");
const fail = (message, code = "CAPTURE_INVALID") => {
  throw Object.assign(new Error(message), { code });
};

export function decisionCaptureWindow(date, slot, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3])[0-5]\d$/.test(slot))
    fail("决策快照日期或时段无效");
  const scheduledAt = `${date}T${slot.slice(0, 2)}:${slot.slice(2)}:00+08:00`;
  const target = Date.parse(scheduledAt);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(target) ||
    new Date(target + 8 * 3600000).toISOString().slice(0, 10) !== date
  )
    fail("决策快照日期或检查时刻无效");
  return {
    scheduledAt,
    target,
    start: target - WINDOW_MS,
    allowed: now >= target - WINDOW_MS && now < target,
    reason:
      now < target - WINDOW_MS ? "before-decision-window" : now >= target ? "window-closed" : null,
  };
}

export function assertDecisionCaptureWindow(date, slot, now = Date.now()) {
  const window = decisionCaptureWindow(date, slot, now);
  if (!window.allowed)
    fail(
      "实际采集已不在目标前15分钟窗口内",
      now >= window.target ? "CAPTURE_LATE" : "CAPTURE_EARLY",
    );
  return window;
}

// Keep the complete official manifest in the audit; request only this target's
// fixtures. A different day's same HHmm must never select today's snapshot.
export function selectDecisionCaptureMatches(matches, date, slot, now = Date.now()) {
  const { target } = assertDecisionCaptureWindow(date, slot, now);
  if (!Array.isArray(matches)) fail("官方比赛清单结构无效");
  const selected = matches.filter(
    (match) =>
      match.salesDate === date &&
      Date.parse(decisionTargetAt(match.salesDate, match.kickoffAt) || "") === target,
  );
  const seen = new Set();
  for (const match of selected) {
    const id = idOf(match);
    if (!/^\d+$/.test(id) || seen.has(id) || match.isMock || !(Date.parse(match.kickoffAt) > now))
      fail("目标时段存在重复、无效或已开赛的官方比赛");
    seen.add(id);
  }
  return selected;
}

export function assertDecisionCaptureComplete(prediction, selected, date, slot, now = Date.now()) {
  const { target, start, scheduledAt } = assertDecisionCaptureWindow(date, slot, now);
  const matches = resolveServerOfficialMatches(prediction, selected, date, now);
  const expected = new Map(selected.map((match) => [idOf(match), match]));
  if (
    !selected.length ||
    expected.size !== selected.length ||
    selectDecisionCaptureMatches(matches, date, slot, now).length !== expected.size
  )
    fail("决策快照目标比赛覆盖不完整或开赛时间发生变化");
  for (const match of matches) {
    const earlier = expected.get(idOf(match));
    if (
      !earlier ||
      ["salesDate", "home", "away"].some((key) => !match[key] || match[key] !== earlier[key]) ||
      Date.parse(match.kickoffAt) !== Date.parse(earlier.kickoffAt)
    )
      fail("官方比赛身份在采集过程中发生变化");
    for (const meta of Object.values(MARKET_META)) {
      const eligibility = match.marketEligibility?.[meta.name];
      if (eligibility?.qualification !== "qualified") continue;
      const odds = match.marketOdds?.[meta.name] || (meta.code === "HAD" ? match.odds : undefined);
      if (
        !Array.isArray(odds) ||
        odds.length !== meta.labels.length ||
        odds.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 1)
      )
        fail("官方可售玩法赔率不完整或无效");
    }
  }
  const reports = prediction.reports;
  if (!Array.isArray(reports) || reports.length !== expected.size)
    fail("目标比赛的预测报告不完整，保留重试资格");
  for (const report of reports) {
    const match = expected.get(String(report.officialMatchId));
    if (
      !match ||
      ["salesDate", "home", "away"].some((key) => report[key] !== match[key]) ||
      Date.parse(report.kickoffAt) !== Date.parse(match.kickoffAt)
    )
      fail("预测报告与目标比赛身份不一致");
    const decision = Date.parse(report.modelInput?.decisionAt || "");
    if (!Number.isFinite(decision) || decision < start || decision > now || decision >= target)
      fail("预测输入不属于本次真实决策窗口");
    for (const value of [
      report.predictionGeneratedAt,
      report.sourceFetchedAt,
      prediction.version?.generatedAt,
    ].filter(Boolean)) {
      const at = Date.parse(value);
      if (!Number.isFinite(at) || at > now) fail("预测生成或来源时刻无效");
    }
    const verified = matches.find((row) => idOf(row) === String(report.officialMatchId));
    if (
      verified.marketEligibility?.["让球胜平负"]?.qualification === "qualified" &&
      (report.marketEligibility?.["让球胜平负"]?.qualification !== "qualified" ||
        Number(report.marketSignal?.officialHandicap) !== report.modelInput?.official?.handicap)
    )
      fail("预测让球玩法与官方资格不一致");
    if (!completePredictionDistribution(report)) fail("正式留档缺少完整一致的五玩法分布");
  }
  // Reuse the same sale/cutoff rules as the immutable completion receipt.
  const receipt = cloudCaptureReceipt(
    {
      immutable: true,
      snapshotId: `${date}-${slot}`,
      recordType: "raw-prediction-snapshot",
      scheduledAt,
      capturedAt: new Date(now).toISOString(),
      reports,
      officialMatches: matches,
    },
    new Date(now).toISOString(),
  );
  if (!receipt.executionEligible) fail(receipt.executionReason);
  return matches;
}
