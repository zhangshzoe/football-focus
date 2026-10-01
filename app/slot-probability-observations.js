const dateOnly = value => String(value || "").match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "";
const kickoffDate = value => Number.isFinite(Date.parse(value || ""))
  ? new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10) : "";

export function probabilitySlotTime(snapshot) {
  const target = Date.parse(snapshot?.scheduledAt || "");
  return Number.isFinite(target) ? new Date(target + 8 * 3600000).toISOString().slice(11, 16) : "";
}

export function isProbabilitySlotSnapshot(snapshot) {
  return ["17:00", "21:00"].includes(probabilitySlotTime(snapshot));
}

/** All frozen forecasts, not just ticket legs. Display numbers never join results. */
export function slotProbabilityObservations(snapshots, results) {
  const resultGroups = new Map();
  for (const result of results || []) {
    const id = String(result.officialMatchId || result.matchId || "");
    if (!id) continue;
    resultGroups.set(id, [...(resultGroups.get(id) || []), result]);
  }
  return (snapshots || []).flatMap(snapshot => (snapshot.matches || []).map(match => {
    const salesDate = match.salesDate || snapshot.date, officialMatchId = String(match.officialMatchId || "");
    const dates = new Set([salesDate, kickoffDate(match.kickoffAt)]);
    const candidates = (resultGroups.get(officialMatchId) || []).filter(result =>
      dates.has(dateOnly(result.salesDate || result.date || result.matchDate)));
    const fulls = new Set(candidates.map(result => String(result.fullScore || "")).filter(Boolean));
    const halves = new Set(candidates.map(result => String(result.halfScore || "")).filter(Boolean));
    return {
      key: `${salesDate}|${officialMatchId}`, snapshotId: snapshot.snapshotId,
      scheduledAt: snapshot.scheduledAt, scheduledTime: probabilitySlotTime(snapshot), salesDate, officialMatchId, kickoffAt: match.kickoffAt,
      capturedAt: snapshot.persistedAt || snapshot.capturedAt,
      includedInStrictEvaluation: snapshot.includedInStrictEvaluation,
      recovered: snapshot.recovered || snapshot.storageOrigin === "recovered",
      baseModelVersion: match.baseModelVersion, calibrationVersion: match.calibrationVersion,
      modelInput: match.modelInput, sourceFetchedAt: match.sourceFetchedAt,
      predictionGeneratedAt: match.predictionGeneratedAt,
      modelHad: match.hadProbabilities || [],
      scoreDistribution: match.fullScoreDistribution || match.combinedScores || [],
      hhadProbabilities: match.hhadProbabilities || [], totalGoalProbabilities: match.totalGoalProbabilities || [],
      halfFullProbabilities: match.halfFullProbabilities || [],
      resultConflict: fulls.size > 1,
      fullScore: fulls.size === 1 ? [...fulls][0] : "",
      halfScore: halves.size === 1 ? [...halves][0] : "",
    };
  }));
}

/** Every unselected/no-bet forecast is included in the result refresh scope. */
export function slotProbabilityResultDates(snapshots, results, now = Date.now()) {
  const earliest = kickoffDate(new Date(now - 29 * 86400000).toISOString()), today = kickoffDate(new Date(now).toISOString());
  const dates = new Set();
  for (const row of slotProbabilityObservations(snapshots, results)) {
    const date = kickoffDate(row.kickoffAt) || row.salesDate;
    if (date >= earliest && date <= today && Date.parse(row.kickoffAt || "") + 3 * 3600000 <= now &&
      (!row.fullScore || (!row.halfScore && row.halfFullProbabilities.length === 9)))
      dates.add(date);
  }
  return [...dates].sort();
}
