import { decisionTargetAt } from "./snapshot-decision-policy.js";

// These two lottery dates have independently retained pre-match evidence, but
// their scheduled raw prediction snapshots were not captured in full.
export const ARCHIVE_RECOVERY_DATES = ["2026-09-23", "2026-09-24"];

const validBeforeDecision = (date, kickoffAt, capturedAt) => {
  const target = Date.parse(decisionTargetAt(date, kickoffAt) || "");
  const captured = Date.parse(capturedAt || "");
  return Number.isFinite(target) && Number.isFinite(captured) && captured <= target;
};

const matchKey = (match) => String(match.officialMatchId || "");

export function buildArchiveRecoverySnapshots(snapshots, purchaseSnapshots, dates = ARCHIVE_RECOVERY_DATES) {
  return dates.flatMap((date) => {
    const formal = snapshots.find(
      (snapshot) => snapshot.date === date && snapshot.snapshotId === `${date}-official-decision-v1`,
    );
    const rows = new Map();
    for (const match of formal?.matches || []) {
      if (matchKey(match)) rows.set(matchKey(match), { ...match, archiveEvidence: "formal" });
    }

    const browser = snapshots
      .filter((snapshot) => snapshot.date === date && snapshot.storageOrigin === "migrated-browser")
      .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
    for (const snapshot of browser) {
      for (const match of snapshot.matches || []) {
        if (
          !matchKey(match) ||
          rows.has(matchKey(match)) ||
          match.isMock ||
          !validBeforeDecision(date, match.kickoffAt, snapshot.capturedAt) ||
          !validBeforeDecision(date, match.kickoffAt, match.predictionGeneratedAt || snapshot.capturedAt)
        ) continue;
        rows.set(matchKey(match), {
          ...match,
          archiveEvidence: "browser_cache",
          archiveCapturedAt: snapshot.capturedAt,
        });
      }
    }

    const plan = purchaseSnapshots
      .filter((snapshot) => snapshot.planSet?.date === date)
      .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)))[0];
    const tickets = new Map();
    for (const group of plan?.planSet?.plans || []) {
      for (const item of group.items || []) {
        if (
          !matchKey(item) ||
          rows.has(matchKey(item)) ||
          !validBeforeDecision(date, item.kickoffAt, plan.capturedAt) ||
          !validBeforeDecision(date, item.kickoffAt, item.sourceFetchedAt || plan.capturedAt)
        ) continue;
        const key = matchKey(item);
        const existing = tickets.get(key) || { item, picks: [] };
        if (!existing.picks.some((pick) => pick.market === item.market && pick.pick === item.pick)) {
          existing.picks.push({ market: item.market, pick: item.pick, probability: item.probability });
        }
        tickets.set(key, existing);
      }
    }
    for (const [key, { item, picks }] of tickets) {
      rows.set(key, {
        id: item.matchId,
        officialMatchId: item.officialMatchId,
        salesDate: item.salesDate,
        kickoffAt: item.kickoffAt,
        league: item.league || "",
        time: item.kickoffAt,
        matchDate: item.matchDate || item.kickoffAt?.slice(0, 10),
        home: item.home,
        away: item.away,
        handicap: item.handicap || "",
        matchStatus: item.matchStatus || "",
        predictionId: plan.predictionId || "",
        sourceFetchedAt: item.sourceFetchedAt || plan.capturedAt,
        generatedAt: plan.capturedAt,
        oddsScores: [],
        confidence: 0,
        completeness: 0,
        archiveEvidence: "purchase_plan_partial",
        archiveCapturedAt: plan.capturedAt,
        purchasePicks: picks,
      });
    }

    const extraCount = rows.size - (formal?.matches?.length || 0);
    if (extraCount <= 0) return [];
    const matches = [...rows.values()].sort((a, b) =>
      String(a.id).localeCompare(String(b.id), "zh-CN", { numeric: true }),
    );
    return [{
      snapshotId: `${date}-recovered-review-v1`,
      date,
      predictionId: `recovery-${date}-v1`,
      capturedAt: formal?.capturedAt || plan?.capturedAt || browser[0]?.capturedAt || "",
      sourceFetchedAt: formal?.sourceFetchedAt || plan?.sourceFetchedAt || browser[0]?.sourceFetchedAt || "",
      decisionTiming: "unknown",
      scheduleLabel: `合并复盘 · ${formal?.matches?.length || 0} 场正式快照 + ${extraCount} 场赛前留存；来源逐场标识`,
      storageOrigin: "recovered",
      matches,
    }];
  });
}
