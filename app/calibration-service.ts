import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { CalibrationBucket, ModelCalibrationProfile, ScorePoint } from "./prediction-config";
import {
  temperatureCalibrate as tempered,
  compatibleCalibration,
  CALIBRATION_STAGE,
} from "./prediction-model.js";
import { decisionTargetAt,selectDecisionObservations } from "./snapshot-decision-policy.js";
import {completeDistribution,scoreProbability,summarizeProbability} from "./probability-evaluation.js";

export type CalibrationObservation = {
  matchKey: string;
  salesDate?:string;officialMatchId?:string;predictionGeneratedAt?:string;shadowGeneratedAt?:string;modelInput?:unknown;
  league: string;
  kickoffAt: string;
  capturedAt: string;
  modelProbabilities: ScorePoint[];
  baseModelProbabilities?: ScorePoint[];
  intelligenceCandidateProbabilities?: ScorePoint[];
  marketProbabilities: ScorePoint[];
  actual: "胜" | "平" | "负";
  totalGoals: number;
  halfGoals?: number;
  homeGoals?: number;
  awayGoals?: number;
  expectedHomeGoals?: number;
  expectedAwayGoals?: number;
  intelligenceCoverage?: number;
};
type ProbabilityMetrics = {
  brier: number|null;
  logLoss: number|null;
  sampleSize: number;
  coverage: number;
  buckets: Array<{ range: string; count: number; meanProbability: number; observedRate: number }>;
};
const directory = join(process.cwd(), "data", "model-calibration");
const bundledProfiles = import.meta.glob<ModelCalibrationProfile>(
  "../data/model-calibration/cal-*.json",
  { eager: true, import: "default" },
);
let runtimeProfile: ModelCalibrationProfile | null = null;
const labels = ["胜", "平", "负"];
// 少于 30 场独立比赛不拟合温度；更大样本也向未校准的温度 1 收缩。
export const MIN_TEMPERATURE_CALIBRATION_MATCHES = 30;
const TEMPERATURE_PRIOR_MATCHES = 30;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const normalized = (points: ScorePoint[]) => {
  const vector=completeDistribution(points,labels);
  if(!vector)throw new Error("概率标签或分布不完整，拒绝校准");
  return vector;
};
const scoreRows = (
  rows: CalibrationObservation[],
  selector: (row: CalibrationObservation) => number[],
  coverage: number,
): ProbabilityMetrics => {
  const metrics=summarizeProbability(rows.map(row=>scoreProbability(selector(row),labels.indexOf(row.actual))));
  return {brier:metrics.brier,logLoss:metrics.logLoss,sampleSize:metrics.sampleSize,coverage,buckets:metrics.reliability};
};
const expectedCalibrationError = (metrics: ProbabilityMetrics) => {
  const total = metrics.buckets.reduce((sum, item) => sum + item.count, 0);
  return total
    ? metrics.buckets.reduce(
        (sum, item) => sum + item.count * Math.abs(item.meanProbability - item.observedRate),
        0,
      ) / total
    : 0;
};
const temperatureLoss = (rows: CalibrationObservation[], temperature: number, coverage: number) =>
  scoreRows(rows, (row) => tempered(normalized(row.modelProbabilities), temperature), coverage)
    .brier! +
  ((0.02 * TEMPERATURE_PRIOR_MATCHES) / (TEMPERATURE_PRIOR_MATCHES + rows.length)) *
    (temperature - 1) ** 2;
const fitTemperature = (rows: CalibrationObservation[], coverage: number) => {
  if (rows.length < MIN_TEMPERATURE_CALIBRATION_MATCHES) return 1;
  const candidates = Array.from({ length: 37 }, (_, index) => 0.7 + index * 0.05);
  return candidates.reduce(
    (best, current) =>
      temperatureLoss(rows, current, coverage) < temperatureLoss(rows, best, coverage)
        ? current
        : best,
    1,
  );
};
const bucket = (rows: CalibrationObservation[]): CalibrationBucket => {
  const totals = rows.map((row) => row.totalGoals).filter(Number.isFinite),
    mean = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 2.6,
    variance =
      totals.length > 1
        ? totals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (totals.length - 1)
        : mean,
    paired = rows.filter(
      (row) =>
        Number.isFinite(row.halfGoals) &&
        Number.isFinite(row.totalGoals) &&
        row.halfGoals! >= 0 &&
        row.halfGoals! <= row.totalGoals,
    ),
    fullTotal = paired.reduce((sum, row) => sum + row.totalGoals, 0),
    halfTotal = paired.reduce((sum, row) => sum + row.halfGoals!, 0);
  return {
    sampleSize: rows.length,
    halfTimePairedSampleSize: paired.length,
    meanTotalGoals: mean,
    goalDispersion: mean ? clamp(variance / mean, 0.85, 1.6) : 1,
    firstHalfGoalShare: fullTotal ? clamp(halfTotal / fullTotal, 0.35, 0.55) : 0.45,
    lowScoreRho: fitLowScoreRho(rows),
  };
};
const profileHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

const poisson = (lambda: number, goals: number) => {
  let factorial = 1;
  for (let index = 2; index <= goals; index++) factorial *= index;
  return (Math.exp(-lambda) * Math.pow(lambda, goals)) / factorial;
};
const dixonColesTau = (
  home: number,
  away: number,
  homeLambda: number,
  awayLambda: number,
  rho: number,
) => {
  if (home === 0 && away === 0) return 1 - homeLambda * awayLambda * rho;
  if (home === 0 && away === 1) return 1 + homeLambda * rho;
  if (home === 1 && away === 0) return 1 + awayLambda * rho;
  if (home === 1 && away === 1) return 1 - rho;
  return 1;
};
function fitLowScoreRho(rows: CalibrationObservation[]) {
  const usable = rows.filter(
    (row) =>
      Number.isInteger(row.homeGoals) &&
      Number.isInteger(row.awayGoals) &&
      numberInRange(row.expectedHomeGoals, 0.1, 5) &&
      numberInRange(row.expectedAwayGoals, 0.1, 5),
  );
  if (usable.length < 20) return 0;
  const candidates = Array.from({ length: 31 }, (_, index) => -0.15 + index * 0.01);
  const loss = (rho: number) =>
    usable.reduce((sum, row) => {
      const home = row.homeGoals!,
        away = row.awayGoals!,
        homeLambda = row.expectedHomeGoals!,
        awayLambda = row.expectedAwayGoals!,
        tau = dixonColesTau(home, away, homeLambda, awayLambda, rho);
      return (
        sum -
        Math.log(
          Math.max(
            1e-8,
            poisson(homeLambda, home) * poisson(awayLambda, away) * Math.max(0.05, tau),
          ),
        )
      );
    }, 0);
  return Number(
    candidates
      .reduce((best, current) => (loss(current) < loss(best) ? current : best), 0)
      .toFixed(2),
  );
}
const numberInRange = (value: unknown, min: number, max: number) =>
  Number.isFinite(Number(value)) && Number(value) >= min && Number(value) <= max;

export function buildCalibrationEvaluation(
  input: CalibrationObservation[],
): ModelCalibrationProfile {
  const valid = input.filter(
    (row) =>
      row.matchKey &&
      Number.isFinite(Date.parse(row.kickoffAt)) &&
      Number.isFinite(Date.parse(row.capturedAt)) &&
      completeDistribution(row.modelProbabilities,labels) &&
      completeDistribution(row.marketProbabilities,labels) &&
      labels.includes(row.actual),
  );
  const grouped = new Map<string, CalibrationObservation[]>();
  valid.forEach((row) => grouped.set(row.matchKey, [...(grouped.get(row.matchKey) || []), row]));
  const selected: Array<CalibrationObservation> = [];
  selected.push(...selectDecisionObservations(valid.map(row=>({...row,salesDate:row.salesDate||row.matchKey.match(/^\d{4}-\d{2}-\d{2}/)?.[0]||row.kickoffAt.slice(0,10)}))).rows);
  selected.sort((a, b) => Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt));
  const trainEnd = Math.floor(selected.length * 0.6),
    calibrationEnd = Math.floor(selected.length * 0.8),
    training = selected.slice(0, trainEnd),
    calibration = selected.slice(trainEnd, calibrationEnd),
    test = selected.slice(calibrationEnd),
    coverage = grouped.size ? selected.length / grouped.size : 0;
  const temperature = fitTemperature(calibration, coverage);
  const fittingRaw = scoreRows(calibration, (row) => normalized(row.modelProbabilities), coverage),
    fittingCalibrated = scoreRows(
      calibration,
      (row) => tempered(normalized(row.modelProbabilities), temperature),
      coverage,
    ),
    testRaw = scoreRows(test, (row) => normalized(row.modelProbabilities), coverage),
    testCalibrated = scoreRows(
      test,
      (row) => tempered(normalized(row.modelProbabilities), temperature),
      coverage,
    ),
    testMarket = scoreRows(test, (row) => normalized(row.marketProbabilities), coverage);
  const rollingRows: CalibrationObservation[] = [],
    rollingMarketRows: CalibrationObservation[] = [];
  let folds = 0,
    foldWins = 0;
  const window = Math.max(2, Math.floor(selected.length * 0.1));
  for (
    let origin = Math.floor(selected.length * 0.5);
    origin + window <= selected.length;
    origin += window
  ) {
    const foldCalibration = selected.slice(Math.max(0, origin - window), origin),
      foldTest = selected.slice(origin, origin + window);
    if (foldCalibration.length < MIN_TEMPERATURE_CALIBRATION_MATCHES || !foldTest.length) continue;
    const foldTemperature = fitTemperature(foldCalibration, coverage),
      foldModel = scoreRows(
        foldTest,
        (row) => tempered(normalized(row.modelProbabilities), foldTemperature),
        coverage,
      ),
      foldMarket = scoreRows(foldTest, (row) => normalized(row.marketProbabilities), coverage);
    if (foldModel.brier! < foldMarket.brier!) foldWins++;
    foldTest.forEach((row) => {
      rollingRows.push({
        ...row,
        modelProbabilities: labels.map((score, index) => ({
          score,
          probability: tempered(normalized(row.modelProbabilities), foldTemperature)[index] * 100,
        })),
      });
      rollingMarketRows.push(row);
    });
    folds++;
  }
  const rollingCalibrated = scoreRows(
      rollingRows,
      (row) => normalized(row.modelProbabilities),
      coverage,
    ),
    rollingMarket = scoreRows(
      rollingMarketRows,
      (row) => normalized(row.marketProbabilities),
      coverage,
    );
  const leagues: Record<string, CalibrationBucket> = {};
  Array.from(new Set(training.map((row) => row.league).filter(Boolean))).forEach((league) => {
    const rows = training.filter((row) => row.league === league);
    if (rows.length >= 5) leagues[league] = bucket(rows);
  });
  const intelligenceTest = test.filter(
      (row) =>
        (row.intelligenceCoverage || 0) > 0 &&
        completeDistribution(row.baseModelProbabilities,labels) &&
        completeDistribution(row.intelligenceCandidateProbabilities,labels),
    ),
    intelligenceBase = scoreRows(
      intelligenceTest,
      (row) => normalized(row.baseModelProbabilities || []),
      coverage,
    ),
    intelligenceFused = scoreRows(
      intelligenceTest,
      (row) => normalized(row.intelligenceCandidateProbabilities || []),
      coverage,
    ),
    intelligenceDelta = intelligenceTest.length ? intelligenceFused.brier! - intelligenceBase.brier! : null,
    intelligenceStatus =
      intelligenceTest.length < 20
        ? "insufficient_data"
        : intelligenceDelta!==null && intelligenceDelta <= -0.005
          ? "validated_gain"
          : "no_gain",
    // Holdout evidence is diagnostic only. It must never select a runtime parameter.
    intelligenceWeightMultiplier = 0;
  const lowScoreRho = fitLowScoreRho(training);
  const deterministic = {
    decisionPolicy: selectDecisionObservations([]).policy,
    splitPolicy: "chronological_60_20_20_v1",
    temperature: Number(temperature.toFixed(2)),
    lowScoreRho,
    intelligenceWeightMultiplier,
    trainingKeys: training.map((row) => row.matchKey),
    calibrationKeys: calibration.map((row) => row.matchKey),
    testKeys: test.map((row) => row.matchKey),
  };
  const promotionGates = [
    {
      key: "raw-replay",
      label: "同版本原始输入完整重放（当前为旧概率诊断）",
      passed: false,
      value: "not-replayed",
    },
    {
      key: "sample",
      label: "未来独立样本 ≥ 100",
      passed: test.length >= 100,
      value: `${test.length}/100`,
    },
    {
      key: "folds",
      label: "滚动验证至少 4 折且 3 折领先",
      passed: folds >= 4 && foldWins >= 3,
      value: `${foldWins}/${folds}`,
    },
    {
      key: "brier",
      label: "未来测试 Brier 至少优于市场 0.005",
      passed: test.length>0 && testCalibrated.brier! <= testMarket.brier! - 0.005,
      value: test.length ? (testCalibrated.brier! - testMarket.brier!).toFixed(3) : "无样本",
    },
    {
      key: "logloss",
      label: "未来测试 Log Loss 不劣于市场",
      passed: test.length>0 && testCalibrated.logLoss! <= testMarket.logLoss!,
      value: test.length ? `${testCalibrated.logLoss!.toFixed(3)} / ${testMarket.logLoss!.toFixed(3)}` : "无样本",
    },
    {
      key: "calibration",
      label: "未来测试概率校准误差更低",
      passed: test.length>0 && expectedCalibrationError(testCalibrated) < expectedCalibrationError(testMarket),
      value: `${(expectedCalibrationError(testCalibrated) * 100).toFixed(1)}% / ${(expectedCalibrationError(testMarket) * 100).toFixed(1)}%`,
    },
    {
      key: "coverage",
      label: "正式决策样本覆盖率 ≥ 95%",
      passed: coverage >= 0.95,
      value: `${(coverage * 100).toFixed(1)}%`,
    },
  ];
  const profileId = `cal-${profileHash(deterministic)}`,
    status = promotionGates.every((gate) => gate.passed) ? "validated" : "insufficient_data";
  const global = { ...bucket(training), lowScoreRho };
  return {
    version: 3,
    schemaVersion: 1,
    evaluationMode: "legacy-probability-diagnostic",
    calibrationStage: CALIBRATION_STAGE,
    profileId,
    status,
    generatedAt: new Date().toISOString(),
    decisionPolicy: deterministic.decisionPolicy,
    splitPolicy: deterministic.splitPolicy,
    forecastSampleSize: selected.length,
    uniqueMatchCount: grouped.size,
    coverage,
    trainingSampleSize: training.length,
    calibrationSampleSize: calibration.length,
    testSampleSize: test.length,
    probabilityTemperature: Number(temperature.toFixed(2)),
    intelligenceWeightMultiplier,
    intelligenceValidation: {
      sampleSize: intelligenceTest.length,
      baseBrier: intelligenceBase.brier,
      fusedBrier: intelligenceFused.brier,
      delta: intelligenceDelta,
      status: intelligenceStatus,
    },
    rawBrier: fittingRaw.brier,
    calibratedBrier: fittingCalibrated.brier,
    fitting: { raw: fittingRaw, calibrated: fittingCalibrated },
    futureTest: { raw: testRaw, calibrated: testCalibrated, marketBaseline: testMarket },
    rollingValidation: {
      folds,
      wins: foldWins,
      sampleSize: rollingRows.length,
      calibrated: rollingCalibrated,
      marketBaseline: rollingMarket,
    },
    promotionGates,
    simulationReturn: null,
    global,
    leagues,
  };
}

export async function getPublishedCalibration() {
  if (runtimeProfile) return runtimeProfile;
  const profiles: ModelCalibrationProfile[] = [...Object.values(bundledProfiles)];
  try {
    for (const name of (await readdir(directory)).filter((name) => /^cal-.*\.json$/.test(name))) {
      try {
        profiles.push(
          JSON.parse(await readFile(join(directory, name), "utf8")) as ModelCalibrationProfile,
        );
      } catch {
        /* 忽略损坏版本。 */
      }
    }
  } catch {
    /* 无磁盘目录时使用打包版本。 */
  }
  runtimeProfile =
    profiles
      .filter((profile) => compatibleCalibration(profile))
      .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))[0] || null;
  return runtimeProfile;
}

export async function publishCalibration(input: CalibrationObservation[]) {
  const evaluation = buildCalibrationEvaluation(input),
    published = await getPublishedCalibration();
  // 页面复盘只能生成候选评估，不能把同一批历史赛果自动写成正式参数。
  // 真正晋级需将通过全部门槛的候选作为新版本审阅、签发并随代码发布。
  return {
    evaluation,
    published,
    promoted: false,
    promotionCandidate: evaluation.status === "validated",
  };
}
