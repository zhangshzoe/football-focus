import {
  completeDistribution,
  EXACT_SCORE_LABELS,
  frozenOfficialMarkets,
  HAD_LABELS,
} from "./probability-evaluation.js";

const points = (values) =>
  HAD_LABELS.map((score, index) => ({ score, probability: values[index] }));
const hadVector = (value) => {
  const rows = Array.isArray(value)
    ? value.every((row) => typeof row === "number")
      ? points(value)
      : value
    : value && typeof value === "object"
      ? points([value.home, value.draw, value.away])
      : [];
  const vector = completeDistribution(rows, HAD_LABELS);
  if (!vector) return null;
  const mass = rows.reduce((sum, row) => sum + row.probability, 0);
  return Math.abs(mass - 100) < 1e-9
    ? HAD_LABELS.map((label) => rows.find((row) => row.score === label).probability)
    : vector.map((probability) => probability * 100);
};

/** Read-only compatibility projection. Never reconstruct a full grid from Top-N. */
export function snapshotOddsProjection(report) {
  let distribution = null;
  for (const candidate of [
    report?.layers?.oddsBaseline?.fullScoreDistribution,
    report?.oddsScores,
  ]) {
    const vector = completeDistribution(candidate, EXACT_SCORE_LABELS);
    if (vector) {
      const mass = candidate.reduce((sum, point) => sum + point.probability, 0);
      distribution = EXACT_SCORE_LABELS.map((score, index) => ({
        score,
        probability:
          Math.abs(mass - 100) < 1e-9
            ? candidate.find((point) => point.score === score).probability
            : vector[index] * 100,
      }));
      break;
    }
  }
  const marginal = [0, 0, 0];
  for (const point of distribution || []) {
    const [home, away] = point.score.split(":").map(Number);
    marginal[home > away ? 0 : home === away ? 1 : 2] += point.probability;
  }
  // Old layer scalars may be fitting targets, not marginals. Preserve them as
  // explicitly labelled diagnostics, never as an official-market benchmark.
  const explicitTarget =
    report?.marketFitTargetHadProbabilities ??
    report?.layers?.oddsBaseline?.marketFitTargetHadProbabilities ??
    report?.marketProbabilities ??
    report?.marketSignal?.rawProbabilities;
  const legacyTarget =
    report?.oddsProbabilityProjectionVersion === 1
      ? null
      : (report?.marketHadProbabilities ?? report?.layers?.oddsBaseline?.probabilities);
  const target = hadVector(explicitTarget) || hadVector(legacyTarget);
  const oddsHadProbabilities = distribution ? points(marginal) : [];
  return {
    oddsScores:
      distribution ||
      report?.layers?.oddsBaseline?.fullScoreDistribution ||
      report?.oddsScores ||
      [],
    oddsHadProbabilities,
    // Compatibility alias only; frozen official odds are scored separately.
    marketHadProbabilities: oddsHadProbabilities,
    marketFitTargetHadProbabilities: target ? points(target) : [],
    oddsProbabilityProjectionVersion: 1,
    marketHadProbabilityBasis: distribution
      ? "odds-score-marginal-v1"
      : "unavailable-incomplete-odds-grid",
    marketFitTargetBasis: target
      ? report?.marketFitTargetBasis ||
        report?.layers?.oddsBaseline?.marketFitTargetBasis ||
        (explicitTarget != null ? "recorded-fit-target" : "legacy-unverified-target")
      : "unavailable",
  };
}

/** New records require a complete odds grid; probabilities use percent units. */
export function buildSnapshotOddsLayer(report) {
  const projection = snapshotOddsProjection({
    ...report,
    oddsScores: report.oddsScores || report.fullScoreDistribution,
  });
  if (projection.oddsHadProbabilities.length !== 3)
    throw new Error("赔率基线缺少完整169比分分布，拒绝保存不一致的概率层");
  const [home, draw, away] = projection.oddsHadProbabilities.map((point) => point.probability);
  return {
    fullScoreDistribution: projection.oddsScores,
    probabilities: { home, draw, away },
    probabilityUnit: "percent",
    probabilityBasis: "odds-score-marginal-v1",
    marketFitTargetHadProbabilities: projection.marketFitTargetHadProbabilities,
    marketFitTargetBasis: projection.marketFitTargetBasis,
  };
}

export function projectSnapshotOddsLayers(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.matches)) return snapshot;
  return {
    ...snapshot,
    matches: snapshot.matches.map((match) => ({ ...match, ...snapshotOddsProjection(match) })),
  };
}

/** A market benchmark must be the verified same-fixture, frozen official quote. */
export function snapshotFrozenOfficialHad(match) {
  const official = match?.modelInput?.official;
  if (
    !official ||
    String(official.officialMatchId || "") !== String(match.officialMatchId || "") ||
    !match.officialMatchId ||
    official.salesDate !== match.salesDate ||
    !Number.isFinite(Date.parse(match.kickoffAt || "")) ||
    Date.parse(official.kickoffAt || "") !== Date.parse(match.kickoffAt)
  )
    return [];
  const baseline = frozenOfficialMarkets(match.modelInput)?.had;
  return baseline ? points(baseline.map((probability) => probability * 100)) : [];
}
