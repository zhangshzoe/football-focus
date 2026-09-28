import {
  asianSettlement,
  asianMarketTarget,
  deVig,
  optionalNumber,
  validAsianLine,
} from "./asian-market.js";
import { assessPredictionInput } from "./prediction-input.js";

export const PREDICTION_PIPELINE_VERSION = "multi-market-poisson-v6-exact-settlement";
export const CALIBRATION_STAGE = "final-score-had-marginal-v1";
const MAX_GOALS = 12;
const normalize = (values) => {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) throw new Error("Empty probability distribution");
  return values.map((value) => value / total);
};
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function temperatureCalibrate(values, temperature = 1) {
  if (!Number.isFinite(temperature) || temperature < 0.7 || temperature > 2.5)
    throw new Error("Invalid temperature");
  return normalize(values.map((value) => Math.pow(Math.max(1e-6, value), 1 / temperature)));
}

export function projectScoreMarkets(points, handicap = null) {
  const had = [0, 0, 0],
    hhad = handicap === null ? [] : [0, 0, 0],
    total = Array(8).fill(0);
  for (const { score, probability } of points) {
    const [h, a] = score.split(":").map(Number),
      p = probability / 100;
    had[h > a ? 0 : h === a ? 1 : 2] += p;
    if (handicap !== null) hhad[h - a + handicap > 0 ? 0 : h - a + handicap === 0 ? 1 : 2] += p;
    total[Math.min(7, h + a)] += p;
  }
  return { had, hhad, total };
}

export function calibrateScoreDistribution(points, temperature = 1) {
  if (temperature === 1) return points.map((point) => ({ ...point }));
  const original = projectScoreMarkets(points).had;
  if (original.some((p) => !(p > 0)))
    throw new Error("Temperature calibration requires all three outcome groups");
  const target = temperatureCalibrate(original, temperature);
  return points.map((point) => {
    const [h, a] = point.score.split(":").map(Number),
      group = h > a ? 0 : h === a ? 1 : 2;
    return { ...point, probability: (point.probability * target[group]) / original[group] };
  });
}

export function compatibleCalibration(profile) {
  return Boolean(
    profile?.schemaVersion === 1 &&
    profile?.status === "validated" &&
    profile.fusionModelVersion === "evidence-and-out-of-sample-gated-v3" &&
    profile.baseModelVersion === PREDICTION_PIPELINE_VERSION &&
    profile.calibrationStage === CALIBRATION_STAGE &&
    profile.evaluationMode === "raw-input-replay" &&
    profile.promotionGates?.length &&
    profile.promotionGates.every((gate) => gate.passed === true),
  );
}

function poissonPmf(lambda) {
  const values = [Math.exp(-lambda)];
  for (let goals = 1; goals <= MAX_GOALS; goals++)
    values.push((values[goals - 1] * lambda) / goals);
  return values;
}

function scoreGrid(home, away, homePmf, awayPmf, rho) {
  const grid = [];
  for (let h = 0; h <= MAX_GOALS; h++)
    for (let a = 0; a <= MAX_GOALS; a++) {
      let tau = 1;
      if (h === 0 && a === 0) tau = 1 - home * away * rho;
      else if (h === 0 && a === 1) tau = 1 + home * rho;
      else if (h === 1 && a === 0) tau = 1 + away * rho;
      else if (h === 1 && a === 1) tau = 1 - rho;
      grid.push(homePmf[h] * awayPmf[a] * Math.max(0.05, tau));
    }
  return normalize(grid);
}

function quarterProjection(line, kind) {
  const wins = [],
    losses = [];
  for (let h = 0; h <= MAX_GOALS; h++)
    for (let a = 0; a <= MAX_GOALS; a++) {
      const result = asianSettlement(kind === "handicap" ? h - a : h + a, line, kind);
      wins.push(result.win);
      losses.push(result.loss);
    }
  return { wins, losses };
}

function riskProbability(grid, quote) {
  let win = 0,
    loss = 0;
  for (let i = 0; i < grid.length; i++) {
    win += grid[i] * quote.wins[i];
    loss += grid[i] * quote.losses[i];
  }
  return win / (win + loss);
}

function asianQuotes(companies, kind) {
  return companies.flatMap((company) => {
    const line = kind === "handicap" ? company.handicap : company.total;
    const target =
      kind === "handicap"
        ? asianMarketTarget(company.homePrice, company.awayPrice)
        : asianMarketTarget(company.overPrice, company.underPrice);
    if (!validAsianLine(line) || target === null || (kind === "total" && line <= 0)) return [];
    return [{ companyId: company.companyId, line, target, ...quarterProjection(line, kind) }];
  });
}

function halfFullDistribution(points, share) {
  // Conditional binomial split preserves the already-fitted full-time distribution.
  const binomial = Array.from({ length: MAX_GOALS + 1 }, (_, goals) => {
    const values = [Math.pow(1 - share, goals)];
    for (let half = 1; half <= goals; half++)
      values.push((((values[half - 1] * (goals - half + 1)) / half) * share) / (1 - share));
    return values;
  });
  const values = Array(9).fill(0),
    result = (h, a) => (h > a ? 0 : h === a ? 1 : 2);
  for (const point of points) {
    const [h, a] = point.score.split(":").map(Number),
      full = result(h, a);
    for (let hh = 0; hh <= h; hh++)
      for (let ha = 0; ha <= a; ha++) {
        values[result(hh, ha) * 3 + full] += point.probability * binomial[h][hh] * binomial[a][ha];
      }
  }
  return values;
}

/** Only entry point for live prediction and historical replay. No I/O or wall clock. */
export function predictFromSnapshot(input, parameters = {}) {
  if (input?.schemaVersion !== 1 || input.pipelineVersion !== PREDICTION_PIPELINE_VERSION)
    throw new Error("Unsupported prediction input version");
  const quality = assessPredictionInput(input.companies || [], input.decisionAt);
  if (quality.status !== "ready") throw new Error(quality.reasons.join("；"));
  const companies = input.companies;
  const sourceProbabilities = companies
    .map((row) => deVig([row.win, row.draw, row.lose], 3))
    .filter(Boolean);
  const external = normalize(
    [0, 1, 2].map((i) => median(sourceProbabilities.map((row) => row[i]))),
  );
  const officialAt = Date.parse(input.official?.fetchedAt),
    decisionAt = Date.parse(input.decisionAt);
  const officialFresh =
    Number.isFinite(officialAt) && officialAt <= decisionAt && decisionAt - officialAt <= 300000;
  const official = officialFresh ? deVig(input.official?.hadOdds, 3) : null;
  const target = official ? external.map((p, i) => p * 0.65 + official[i] * 0.35) : external;
  const handicap = optionalNumber(input.official?.handicap);
  const hhadTarget =
    handicap === null || !officialFresh ? null : deVig(input.official?.hhadOdds, 3);
  const asian = asianQuotes(companies, "handicap"),
    totals = asianQuotes(companies, "total");
  // Parameters must come from a frozen, version-compatible replay candidate/profile.
  const rho = Math.max(-0.15, Math.min(0.15, parameters.lowScoreRho || 0));
  const dispersion = Math.max(1, Math.min(1.6, parameters.goalDispersion || 1));
  const spread = Math.min(0.28, Math.sqrt(dispersion - 1) * 0.32);
  const tempos =
    spread > 0.005
      ? [
          { scale: 1 - spread, weight: 0.2 },
          { scale: 1, weight: 0.6 },
          { scale: 1 + spread, weight: 0.2 },
        ]
      : [{ scale: 1, weight: 1 }];
  const homeGrid = Array.from({ length: 75 }, (_, i) => (5 + i) / 20);
  const awayGrid = Array.from({ length: 71 }, (_, i) => (4 + i) / 20);
  const homePmfs = homeGrid.map((lambda) => tempos.map((t) => poissonPmf(lambda * t.scale)));
  const awayPmfs = awayGrid.map((lambda) => tempos.map((t) => poissonPmf(lambda * t.scale)));
  let best = null;
  const meanSquare = (first, second) => first.reduce((sum, p, i) => sum + (p - second[i]) ** 2, 0);
  for (let hi = 0; hi < homeGrid.length; hi++)
    for (let ai = 0; ai < awayGrid.length; ai++) {
      const home = homeGrid[hi],
        away = awayGrid[ai];
      const grid = Array((MAX_GOALS + 1) ** 2).fill(0);
      for (let ti = 0; ti < tempos.length; ti++) {
        const tempo = tempos[ti],
          partial = scoreGrid(
            home * tempo.scale,
            away * tempo.scale,
            homePmfs[hi][ti],
            awayPmfs[ai][ti],
            rho,
          );
        for (let i = 0; i < grid.length; i++) grid[i] += partial[i] * tempo.weight;
      }
      const had = [0, 0, 0],
        hhad = [0, 0, 0];
      for (let h = 0; h <= MAX_GOALS; h++)
        for (let a = 0; a <= MAX_GOALS; a++) {
          const p = grid[h * (MAX_GOALS + 1) + a];
          had[h > a ? 0 : h === a ? 1 : 2] += p;
          if (handicap !== null)
            hhad[h - a + handicap > 0 ? 0 : h - a + handicap === 0 ? 1 : 2] += p;
        }
      const asianError =
        asian.reduce((sum, quote) => sum + (riskProbability(grid, quote) - quote.target) ** 2, 0) /
        asian.length;
      const totalError =
        totals.reduce((sum, quote) => sum + (riskProbability(grid, quote) - quote.target) ** 2, 0) /
        totals.length;
      const historyWeight = Math.min(0.12, (parameters.sampleSize || 0) / 250);
      const historyError = Number.isFinite(parameters.meanTotalGoals)
        ? ((home + away - parameters.meanTotalGoals) / 3) ** 2 * historyWeight
        : 0;
      const error =
        meanSquare(had, target) * 0.48 +
        asianError * 0.3 +
        totalError * 0.18 +
        (hhadTarget ? meanSquare(hhad, hhadTarget) * 0.38 : 0) +
        historyError;
      if (!best || error < best.error) best = { home, away, error, grid };
    }
  const uncalibrated = best.grid.map((p, i) => ({
    score: `${Math.floor(i / (MAX_GOALS + 1))}:${i % (MAX_GOALS + 1)}`,
    probability: p * 100,
  }));
  const points = calibrateScoreDistribution(uncalibrated, parameters.temperature || 1).sort(
    (a, b) => b.probability - a.probability || a.score.localeCompare(b.score),
  );
  const markets = projectScoreMarkets(points, handicap);
  const totalBaseline = officialFresh ? deVig(input.official?.totalOdds, 8) : null;
  const finalGrid = Array(best.grid.length).fill(0),
    expectedGoals = [0, 0];
  for (const point of points) {
    const [h, a] = point.score.split(":").map(Number),
      p = point.probability / 100;
    finalGrid[h * (MAX_GOALS + 1) + a] = p;
    expectedGoals[0] += h * p;
    expectedGoals[1] += a * p;
  }
  return {
    pipelineVersion: PREDICTION_PIPELINE_VERSION,
    calibrationStage: CALIBRATION_STAGE,
    officialFresh,
    expectedGoals,
    fittedLambdas: [best.home, best.away],
    scores: points.slice(0, 4),
    fullScoreDistribution: points,
    uncalibratedFullScoreDistribution: uncalibrated,
    marketProbabilities: target,
    hhadProbabilities: markets.hhad.map((p) => p * 100),
    totalGoalProbabilities: markets.total.map((p) => p * 100),
    halfFullProbabilities: halfFullDistribution(
      points,
      Math.max(0.35, Math.min(0.55, parameters.firstHalfGoalShare || 0.45)),
    ),
    marketTotalGoalProbabilities: totalBaseline?.map((p) => p * 100) || null,
    fitError: best.error,
    fitErrorStage: "pre-temperature-parameter-fit",
    lowScoreRho: rho,
    quality,
    priceDiagnostics: [
      ...asian.map((q) => ({ kind: "handicap", ...q })),
      ...totals.map((q) => ({ kind: "total", ...q })),
    ].map(({ wins, losses, ...q }) => ({
      ...q,
      modeledRiskProbability: riskProbability(finalGrid, { wins, losses }),
    })),
  };
}
