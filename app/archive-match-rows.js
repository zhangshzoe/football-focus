const normalizedName = (value) => String(value || "").replace(/[\s·.（）()]/g, "").toLowerCase();
const saleDate = (row) => String(row.match?.salesDate || row.snapshot?.date || row.result?.date || "").slice(0, 10);
const kickoff = (match) => {
  const instant = Date.parse(String(match.kickoffAt || ""));
  if (Number.isFinite(instant)) return new Date(instant).toISOString();
  const date = String(match.matchDate || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
  const time = String(match.time || "").match(/\d{1,2}:\d{2}/)?.[0] || "";
  return date && time ? `${date}T${time.padStart(5, "0")}` : "";
};
const fixtureKey = (row) => {
  const match = row.match;
  const schedule = kickoff(match) || String(match.id || "");
  return `${saleDate(row)}|${normalizedName(match.home)}|${normalizedName(match.away)}|${schedule}`;
};
const officialKey = (row) => {
  const id = String(row.match.officialMatchId || "").trim();
  return id ? `${saleDate(row)}|${id}` : "";
};
const matchNumber = (match) => {
  const code = String(match.id || "");
  const suffix = code.match(/(\d+)\s*$/)?.[1];
  return suffix ? Number(suffix) : Number.POSITIVE_INFINITY;
};

export function compareArchiveMatchRows(left, right) {
  const dateOrder = saleDate(left).localeCompare(saleDate(right));
  if (dateOrder) return dateOrder;
  const numberOrder = matchNumber(left.match) - matchNumber(right.match);
  if (Number.isFinite(numberOrder) && numberOrder) return numberOrder;
  return kickoff(left.match).localeCompare(kickoff(right.match)) ||
    String(left.match.id || "").localeCompare(String(right.match.id || ""), "zh-CN", { numeric: true }) ||
    fixtureKey(left).localeCompare(fixtureKey(right));
}

const rowPriority = (row) => {
  const snapshot = row.snapshot || {};
  const formal = row.match.archiveEvidence === "formal" || String(snapshot.predictionId || "").includes("official-decision");
  const origin = snapshot.storageOrigin === "server" ? 2 : snapshot.storageOrigin === "migrated-browser" ? 1 : 0;
  const complete = ["hadProbabilities", "hhadProbabilities", "totalGoalProbabilities", "halfFullProbabilities", "oddsScores"].filter((field) => row.match[field]?.length).length;
  const captured = Date.parse(String(snapshot.capturedAt || snapshot.sourceFetchedAt || row.match.archiveCapturedAt || ""));
  const start = Date.parse(String(row.match.kickoffAt || ""));
  const preMatch = Number.isFinite(captured) && Number.isFinite(start) && captured <= start;
  return [Number(formal), origin, Number(preMatch), complete, Number.isFinite(captured) ? captured : 0];
};
const betterRow = (candidate, existing) => {
  const candidatePriority = rowPriority(candidate);
  const existingPriority = rowPriority(existing);
  for (let index = 0; index < candidatePriority.length; index++) {
    if (candidatePriority[index] !== existingPriority[index]) return candidatePriority[index] > existingPriority[index];
  }
  return false;
};

// Keep immutable source snapshots intact; deduplicate only the review projection.
export function uniqueArchiveMatchRows(rows) {
  const fixtureToOfficial = new Map();
  for (const row of rows) {
    const official = officialKey(row);
    if (official) fixtureToOfficial.set(fixtureKey(row), official);
  }
  const unique = new Map();
  for (const row of rows) {
    const fixture = fixtureKey(row);
    const key = officialKey(row) || fixtureToOfficial.get(fixture) || `fixture|${fixture}`;
    const existing = unique.get(key);
    if (!existing || betterRow(row, existing)) unique.set(key, row);
  }
  return Array.from(unique.values()).sort(compareArchiveMatchRows);
}
