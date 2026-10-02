import { completeDistribution, EXACT_SCORE_LABELS } from "./probability-evaluation.js";
import { expectedHalfFullDistribution } from "./half-full-validation.js";

const validVector = (values, count) =>
  Array.isArray(values) &&
  values.length === count &&
  values.every(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100,
  ) &&
  Math.abs(values.reduce((sum, value) => sum + value, 0) - 100) < 1e-5;

// Shared by local and cloud capture. Matching array lengths alone cannot prove
// that all five projections describe the same frozen probability distribution.
export function completePredictionDistribution(report) {
  const grid = completeDistribution(report.fullScoreDistribution, EXACT_SCORE_LABELS);
  const had = [report.probabilities?.home, report.probabilities?.draw, report.probabilities?.away];
  const total = report.marketSignal?.modeledTotalGoals,
    halfFull = report.marketSignal?.modeledHalfFull;
  const hhad = report.marketSignal?.modeledHhad;
  const qualified = report.marketEligibility?.["让球胜平负"]?.qualification === "qualified";
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
}
