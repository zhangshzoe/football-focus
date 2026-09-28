import { deVig } from "./asian-market.js";
import { predictFromSnapshot, PREDICTION_PIPELINE_VERSION } from "./prediction-model.js";

const topTwo = (probabilities) =>
  probabilities
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p - a.p || a.i - b.i)
    .slice(0, 2)
    .map((row) => row.i);
const validDistribution = (values) =>
  Array.isArray(values) &&
  values.length === 8 &&
  values.every((p) => Number.isFinite(p) && p >= 0) &&
  Math.abs(values.reduce((a, b) => a + b, 0) - 1) < 1e-6;

// Accept only frozen pre-match inputs and contemporaneous complete official TTG odds.
export function replayTotalGoals(record) {
  const input = record?.modelInput,
    official = input?.official;
  if (!input || input.pipelineVersion !== PREDICTION_PIPELINE_VERSION)
    return { status: "unavailable", reason: "missing-compatible-raw-input" };
  if (!record.snapshotId || !official?.officialMatchId || !official?.salesDate)
    return { status: "unavailable", reason: "missing-provenance" };
  const decision = Date.parse(input.decisionAt),
    captured = Date.parse(record.capturedAt),
    kickoff = Date.parse(official.kickoffAt),
    fetched = Date.parse(official.fetchedAt);
  if (
    ![decision, captured, kickoff, fetched].every(Number.isFinite) ||
    captured < decision ||
    captured >= kickoff ||
    decision >= kickoff ||
    fetched > decision ||
    decision - fetched > 300000
  )
    return { status: "unavailable", reason: "invalid-or-stale-timestamps" };
  const market = deVig(official.totalOdds, 8);
  if (!market) return { status: "unavailable", reason: "missing-complete-official-total-odds" };
  if (!Number.isInteger(record.actualTotalGoals) || record.actualTotalGoals < 0)
    return { status: "unavailable", reason: "missing-verified-result" };
  try {
    const output = predictFromSnapshot(input, record.modelParameters || {}),
      model = output.totalGoalProbabilities.map((p) => p / 100);
    return {
      status: "ready",
      key: `${official.officialMatchId}|${official.salesDate}`,
      snapshotId: record.snapshotId,
      decisionAt: input.decisionAt,
      pipelineVersion: input.pipelineVersion,
      model,
      market,
      odds: [...official.totalOdds],
      actual: Math.min(7, record.actualTotalGoals),
      modelTopTwo: topTwo(model),
      marketTopTwo: topTwo(market),
    };
  } catch (error) {
    return { status: "unavailable", reason: `invalid-input: ${error.message}` };
  }
}

export function summarizeTotalGoals(records) {
  const attempts = records.map(replayTotalGoals),
    unique = new Map();
  for (const row of attempts.filter((row) => row.status === "ready")) {
    if (!unique.has(row.key) || row.decisionAt > unique.get(row.key).decisionAt)
      unique.set(row.key, row);
  }
  const rows = [...unique.values()],
    metrics = (field) => {
      if (!rows.length) return { sampleSize: 0, topTwoHitRate: null, brier: null, logLoss: null };
      return {
        sampleSize: rows.length,
        topTwoHitRate:
          rows.filter((row) => topTwo(row[field]).includes(row.actual)).length / rows.length,
        brier:
          rows.reduce(
            (sum, row) =>
              sum + row[field].reduce((v, p, i) => v + (p - (i === row.actual ? 1 : 0)) ** 2, 0),
            0,
          ) / rows.length,
        logLoss:
          rows.reduce((sum, row) => sum - Math.log(Math.max(1e-12, row[field][row.actual])), 0) /
          rows.length,
      };
    };
  return {
    attempted: records.length,
    comparableMatches: rows.length,
    duplicatesExcluded: attempts.filter((row) => row.status === "ready").length - rows.length,
    exclusions: attempts
      .filter((row) => row.status !== "ready")
      .reduce((counts, row) => ({ ...counts, [row.reason]: (counts[row.reason] || 0) + 1 }), {}),
    model: metrics("model"),
    market: metrics("market"),
    rows,
    promotionEligible: false,
  };
}

// Paired counterfactual: SAME matches, snapshot and stake. Never reselect the market's matches.
export function compareTotalGoalTickets(rows) {
  if (
    ![2, 3].includes(rows.length) ||
    new Set(rows.map((row) => row.key)).size !== rows.length ||
    new Set(rows.map((row) => `${row.snapshotId}|${row.decisionAt}|${row.pipelineVersion}`))
      .size !== 1 ||
    rows.some(
      (row) =>
        row.status !== "ready" ||
        !row.key ||
        !row.snapshotId ||
        !validDistribution(row.model) ||
        !validDistribution(row.market) ||
        !deVig(row.odds, 8) ||
        !Number.isInteger(row.actual) ||
        row.actual < 0 ||
        row.actual > 7,
    )
  )
    throw new Error(
      "Ticket comparison requires 2/3 distinct matched records from the same decision snapshot",
    );
  const stake = 2 * 2 ** rows.length;
  const result = (field) => {
    const selected = rows.map((row) => topTwo(row[field])),
      won = rows.every((row, i) => selected[i].includes(row.actual));
    const returned = won ? 2 * rows.reduce((odd, row) => odd * row.odds[row.actual], 1) : 0;
    return {
      selections: selected,
      stake,
      won,
      returned,
      netProfit: returned - stake,
      estimatedHitProbability: rows.reduce(
        (p, row, i) => p * selected[i].reduce((sum, index) => sum + row[field][index], 0),
        1,
      ),
    };
  };
  return {
    passName: `${rows.length}串1`,
    assumption: "independent-matches",
    model: result("model"),
    market: result("market"),
  };
}
