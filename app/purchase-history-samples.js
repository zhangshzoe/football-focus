// Read-only sample metadata for saved strategy history. A unique fixture count
// is NOT evidence of statistical independence; real ticket/cash rows stay intact.
const settledStatuses = new Set(["won", "lost", "corrected_won", "corrected_lost", "void_won", "void_lost"]);
const knownText = value => typeof value === "string" && value.trim() ? value.trim() : null;
const salesDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? value : null;

function frozenRiskPolicy(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
}

function countRows(rows) {
  const batches = new Set(), days = new Set(), fixtureDates = new Map();
  let unidentifiedFixtureOccurrences = 0;
  for (const row of rows) {
    if (knownText(row.batchIdentity)) batches.add(row.batchIdentity);
    if (salesDate(row.date)) days.add(row.date);
    for (const item of row.plan?.items || []) {
      const officialId = knownText(item.officialMatchId), date = salesDate(item.salesDate);
      if (!officialId || !date) { unidentifiedFixtureOccurrences++; continue; }
      if (!fixtureDates.has(officialId)) fixtureDates.set(officialId, new Set());
      fixtureDates.get(officialId).add(date);
    }
  }
  // Conflicting sales dates for one official ID do not manufacture more samples.
  const fixtureIdentityConflicts = [...fixtureDates.values()].filter(dates => dates.size !== 1).length;
  return {
    ticketCount: rows.length,
    batchCount: batches.size,
    uniqueFixtureCount: fixtureDates.size - fixtureIdentityConflicts,
    salesDayCount: days.size,
    unidentifiedFixtureOccurrences,
    fixtureIdentityConflicts,
  };
}

function sampleCounts(rows) {
  const settled = rows.filter(row => settledStatuses.has(row.plan?.status));
  return {
    ...countRows(rows),
    settledTicketCount: settled.length,
    refundedTicketCount: rows.filter(row => row.plan?.status === "refunded").length,
    settledUniqueFixtureCount: countRows(settled).uniqueFixtureCount,
    settledSalesDayCount: countRows(settled).salesDayCount,
  };
}

export function summarizePurchaseHistorySamples(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const basis = {
      decisionPolicy: knownText(row.decisionPolicy),
      baseModelVersion: knownText(row.baseModelVersion),
      calibrationVersion: knownText(row.calibrationVersion),
      riskPolicy: frozenRiskPolicy(row.riskPolicy),
    };
    const key = JSON.stringify(basis);
    if (!groups.has(key)) groups.set(key, {key, ...basis, rows: []});
    groups.get(key).rows.push(row);
  }
  return {
    scope: "saved-strategy-ticket-rows",
    statisticalIndependenceEstablished: false,
    ...sampleCounts(rows),
    versionGroups: [...groups.values()].sort((a, b) => a.key.localeCompare(b.key)).map(({rows: groupRows, ...basis}) => ({
      ...basis,
      ...sampleCounts(groupRows),
    })),
  };
}
