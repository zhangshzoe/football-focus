import {mkdir, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {decisionTargetAt} from "../app/snapshot-decision-policy.js";

const BASE_URL = process.env.FOOTBALL_FOCUS_URL || "http://localhost:3000";
const OUTPUT_DIRECTORY = join(process.cwd(), "data", "analysis");
const LABELS = ["胜", "平", "负"];

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const datePart = (value) => String(value || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
const normalizedName = (value) => String(value || "").toLowerCase().replace(/[\s·.\-_/（）()]/g, "");
const shiftDate = (date, offset) => {
  const value = new Date(`${date}T12:00:00+08:00`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};
const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const pct = (hits, total) => total ? hits / total * 100 : null;
const rounded = (value, digits = 3) => value === null ? null : Number(value.toFixed(digits));

async function json(path) {
  const response = await fetch(`${BASE_URL}${path}`, {headers: {accept: "application/json"}});
  const body = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${body.slice(0, 200)}`);
  try { return JSON.parse(body); }
  catch { throw new Error(`${path} 未返回 JSON：${body.slice(0, 200)}`); }
}

function points(value) {
  const clean = Array.isArray(value) ? value.map((item) => ({score: String(item?.score || ""), probability: number(item?.probability)})).filter((item) => item.score && item.probability >= 0) : [];
  const total = clean.reduce((sum, item) => sum + item.probability, 0);
  return total > 0 ? clean.map((item) => ({...item, probability: item.probability / total * 100})).sort((a, b) => b.probability - a.probability) : [];
}

function derivedHad(scorePoints) {
  const values = [0, 0, 0];
  points(scorePoints).forEach((point) => {
    const [home, away] = point.score.split(":").map(Number);
    if (!Number.isFinite(home) || !Number.isFinite(away)) return;
    values[home > away ? 0 : home === away ? 1 : 2] += point.probability;
  });
  return LABELS.map((score, index) => ({score, probability: values[index]}));
}

function kickoffAt(match, snapshotDate) {
  if (Number.isFinite(Date.parse(match.kickoffAt || ""))) return match.kickoffAt;
  const raw = String(match.matchDate || match.time || "");
  const date = datePart(raw) || snapshotDate;
  const clock = raw.match(/\d{2}:\d{2}/)?.[0];
  return clock ? `${date}T${clock}:00+08:00` : "";
}

function resultCandidates(match, snapshotDate) {
  const explicit = datePart(match.kickoffAt) || datePart(match.matchDate) || datePart(match.time);
  return explicit ? [explicit] : [shiftDate(snapshotDate, -1), snapshotDate, shiftDate(snapshotDate, 1)];
}

function findResult(match, snapshotDate, resultsByDate) {
  const candidates = resultCandidates(match, snapshotDate).flatMap((date) => resultsByDate.get(date) || []);
  const officialId = String(match.officialMatchId || "");
  if (officialId) {
    const exact = candidates.find((result) => String(result.officialMatchId || result.matchId || "") === officialId);
    if (exact) return exact;
  }
  const id = String(match.id || "");
  const exactId = candidates.filter((result) => String(result.id || "") === id);
  if (exactId.length === 1) return exactId[0];
  const home = normalizedName(match.home), away = normalizedName(match.away);
  return candidates.find((result) => normalizedName(result.home) === home && normalizedName(result.away) === away) || null;
}

function outcome(home, away) { return home > away ? "胜" : home === away ? "平" : "负"; }
function hhadOutcome(home, away, handicap) {
  const adjusted = home - away + Number(handicap);
  return adjusted > 0 ? "让胜" : adjusted === 0 ? "让平" : "让负";
}
function brier(probabilities, actual) {
  const normalized = points(probabilities);
  if (normalized.length !== 3 || !LABELS.includes(actual)) return null;
  return normalized.reduce((sum, item) => sum + (item.probability / 100 - (item.score === actual ? 1 : 0)) ** 2, 0);
}
function logLoss(probabilities, actual) {
  const probability = points(probabilities).find((item) => item.score === actual)?.probability;
  return probability ? -Math.log(Math.max(1e-6, probability / 100)) : null;
}

function metricSummary(rows) {
  const scoreEligible = rows.filter((row) => row.scores.length);
  const hadEligible = rows.filter((row) => row.had.length === 3);
  const hhadEligible = rows.filter((row) => row.hhad.length === 3 && row.handicap !== "");
  const totalEligible = rows.filter((row) => row.total.length);
  const halfFullEligible = rows.filter((row) => row.halfFull.length && row.actualHalfFull);
  const modelBriers = hadEligible.map((row) => brier(row.had, row.actualHad)).filter(Number.isFinite);
  const modelLogLosses = hadEligible.map((row) => logLoss(row.had, row.actualHad)).filter(Number.isFinite);
  const marketRows = rows.filter((row) => row.marketHad.length === 3);
  const marketBriers = marketRows.map((row) => brier(row.marketHad, row.actualHad)).filter(Number.isFinite);
  const marketLogLosses = marketRows.map((row) => logLoss(row.marketHad, row.actualHad)).filter(Number.isFinite);
  return {
    matches: rows.length,
    scoreTop1: {eligible: scoreEligible.length, rate: rounded(pct(scoreEligible.filter((row) => row.scores[0]?.score === row.actualScore).length, scoreEligible.length), 1)},
    scoreTop3: {eligible: scoreEligible.length, rate: rounded(pct(scoreEligible.filter((row) => row.scores.slice(0, 3).some((item) => item.score === row.actualScore)).length, scoreEligible.length), 1)},
    hadTop1: {eligible: hadEligible.length, rate: rounded(pct(hadEligible.filter((row) => row.had[0]?.score === row.actualHad).length, hadEligible.length), 1)},
    hhadTop1: {eligible: hhadEligible.length, rate: rounded(pct(hhadEligible.filter((row) => row.hhad[0]?.score === row.actualHhad).length, hhadEligible.length), 1)},
    totalTop1: {eligible: totalEligible.length, rate: rounded(pct(totalEligible.filter((row) => row.total[0]?.score.replace("球", "") === row.actualTotal).length, totalEligible.length), 1)},
    totalTop2: {eligible: totalEligible.length, rate: rounded(pct(totalEligible.filter((row) => row.total.slice(0, 2).some((item) => item.score.replace("球", "") === row.actualTotal)).length, totalEligible.length), 1)},
    halfFullTop1: {eligible: halfFullEligible.length, rate: rounded(pct(halfFullEligible.filter((row) => row.halfFull[0]?.score === row.actualHalfFull).length, halfFullEligible.length), 1)},
    modelBrier: rounded(average(modelBriers)),
    modelLogLoss: rounded(average(modelLogLosses)),
    marketBrier: rounded(average(marketBriers)),
    marketLogLoss: rounded(average(marketLogLosses)),
    marketComparable: marketRows.length,
  };
}

const archive = await json("/api/prediction-snapshots");
const snapshots = Array.isArray(archive.snapshots) ? archive.snapshots : [];
const dates = new Set();
snapshots.forEach((snapshot) => snapshot.matches?.forEach((match) => resultCandidates(match, snapshot.date).forEach((date) => dates.add(date))));
const resultsByDate = new Map();
const shanghaiToday = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"}).format(new Date());
await Promise.all([...dates].filter((date) => date <= shanghaiToday).sort().map(async (date) => {
  const payload = await json(`/api/sporttery/results?date=${date}`);
  resultsByDate.set(date, Array.isArray(payload.results) ? payload.results : []);
}));

const rows = [];
for (const snapshot of snapshots) for (const match of snapshot.matches || []) {
  const result = findResult(match, snapshot.date, resultsByDate);
  const full = String(result?.fullScore || "").split(":").map(Number);
  const half = String(result?.halfScore || "").split(":").map(Number);
  const actualScore = full.length === 2 && full.every(Number.isFinite) ? `${full[0]}:${full[1]}` : "";
  const actualHalfFull = actualScore && half.length === 2 && half.every(Number.isFinite) ? `${outcome(half[0], half[1])}${outcome(full[0], full[1])}` : "";
  const fusedScores = points(match.fullScoreDistribution?.length ? match.fullScoreDistribution : match.combinedScores?.length ? match.combinedScores : match.oddsScores);
  const had = points(match.hadProbabilities?.length === 3 ? match.hadProbabilities : derivedHad(fusedScores));
  rows.push({
    snapshotId: snapshot.snapshotId,
    snapshotDate: snapshot.date,
    capturedAt: snapshot.capturedAt || snapshot.sourceFetchedAt || "",
    scheduledAt: snapshot.scheduledAt || "",
    schemaVersion: snapshot.schemaVersion || 1,
    immutable: snapshot.immutable === true,
    predictionId: match.predictionId || snapshot.predictionId || "",
    baseModelVersion: match.baseModelVersion || "",
    calibrationVersion: match.calibrationVersion || "",
    matchKey: match.officialMatchId || `${snapshot.date}|${match.id}|${normalizedName(match.home)}|${normalizedName(match.away)}`,
    officialMatchId: match.officialMatchId || "",
    id: match.id,
    league: match.league || "其他联赛",
    home: match.home,
    away: match.away,
    salesDate: match.salesDate || snapshot.date,
    kickoffAt: kickoffAt(match, snapshot.date),
    mappingStatus: match.officialMappingStatus || "",
    intelligenceCoverage: number(match.intelligenceCoverage),
    result,
    actualScore,
    actualHad: actualScore ? outcome(full[0], full[1]) : "",
    actualHhad: actualScore && String(match.handicap ?? result?.handicap ?? "") !== "" ? hhadOutcome(full[0], full[1], match.handicap ?? result?.handicap) : "",
    actualTotal: actualScore ? String(Math.min(7, full[0] + full[1])) : "",
    actualHalfFull,
    scores: fusedScores,
    had,
    hhad: points(match.hhadProbabilities),
    total: points(match.totalGoalProbabilities),
    halfFull: points(match.halfFullProbabilities),
    marketHad: points(match.marketHadProbabilities),
    handicap: String(match.handicap ?? result?.handicap ?? ""),
  });
}

const grouped = new Map();
rows.filter((row) => row.result && row.actualScore).forEach((row) => grouped.set(row.matchKey, [...(grouped.get(row.matchKey) || []), row]));
const selected = [];
for (const group of grouped.values()) {
  const sorted = group.slice().sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
  const reference = sorted.find((row) => Number.isFinite(Date.parse(row.kickoffAt)));
  const kickoff = Date.parse(reference?.kickoffAt || "");
  const targetAt = decisionTargetAt(reference?.salesDate || reference?.snapshotDate, reference?.kickoffAt);
  const strict = targetAt ? sorted.filter((row) => Date.parse(row.capturedAt) <= Date.parse(targetAt)) : [];
  const preMatch = Number.isFinite(kickoff) ? sorted.filter((row) => Date.parse(row.capturedAt) < kickoff) : [];
  const chosen = strict.at(-1) || preMatch.at(-1) || sorted[0];
  selected.push({...chosen, decisionTargetAt: targetAt || "", decisionPolicy: strict.length ? "latest_not_after_official_target_v1" : preMatch.length ? "latest_pre_match_fallback" : "time_unverified"});
}
selected.sort((a, b) => Date.parse(a.kickoffAt || a.capturedAt) - Date.parse(b.kickoffAt || b.capturedAt));
const strictSelected = selected.filter((row) => row.decisionPolicy === "latest_not_after_official_target_v1");

const allFieldChecks = {
  officialMatchId: rows.filter((row) => row.officialMatchId).length,
  verifiedMapping: rows.filter((row) => row.mappingStatus === "verified").length,
  validKickoffAt: rows.filter((row) => Number.isFinite(Date.parse(row.kickoffAt))).length,
  predictionId: rows.filter((row) => row.predictionId).length,
  fullScoreDistribution: rows.filter((row) => row.scores.length >= 20).length,
  marketHadBaseline: rows.filter((row) => row.marketHad.length === 3).length,
  hhadPrediction: rows.filter((row) => row.hhad.length === 3).length,
  totalGoalPrediction: rows.filter((row) => row.total.length >= 8).length,
  halfFullPrediction: rows.filter((row) => row.halfFull.length >= 9).length,
  validIntelligenceEvidence: rows.filter((row) => row.intelligenceCoverage > 0).length,
  matchedResult: rows.filter((row) => row.result && row.actualScore).length,
};

const byLeague = [...new Set(strictSelected.map((row) => row.league))].map((league) => {
  const leagueRows = strictSelected.filter((row) => row.league === league);
  return {league, ...metricSummary(leagueRows)};
}).sort((a, b) => b.matches - a.matches);

const aiRows = strictSelected.filter((row) => row.intelligenceCoverage > 0 && row.marketHad.length === 3 && row.had.length === 3);
const aiModelBrier = average(aiRows.map((row) => brier(row.had, row.actualHad)).filter(Number.isFinite));
const aiMarketBrier = average(aiRows.map((row) => brier(row.marketHad, row.actualHad)).filter(Number.isFinite));
const summary = {
  generatedAt: new Date().toISOString(),
  source: `${BASE_URL}/api/prediction-snapshots + /api/sporttery/results`,
  grain: "工作日22:00及以后按21:30、周末23:00及以后按22:30；其他比赛按开赛前30分钟。每场取不晚于该时点的最近快照",
  inventory: {
    snapshotCount: snapshots.length,
    legacySnapshotCount: snapshots.filter((snapshot) => (snapshot.schemaVersion || 1) < 2).length,
    immutableSnapshotCount: snapshots.filter((snapshot) => snapshot.immutable === true).length,
    rawPredictionRows: rows.length,
    uniqueSettledMatches: grouped.size,
    selectedDecisionRows: selected.length,
    strictDecisionRows: strictSelected.length,
    fallbackDecisionRows: selected.length - strictSelected.length,
  },
  completeness: Object.fromEntries(Object.entries(allFieldChecks).map(([key, count]) => [key, {count, total: rows.length, rate: rounded(pct(count, rows.length), 1)}])),
  overall: metricSummary(strictSelected),
  aiContribution: {
    comparableMatches: aiRows.length,
    fusedBrier: rounded(aiModelBrier),
    marketBaselineBrier: rounded(aiMarketBrier),
    brierDelta: aiModelBrier === null || aiMarketBrier === null ? null : rounded(aiModelBrier - aiMarketBrier),
    interpretation: aiRows.length < 30 ? "样本不足，不能据此固定或放大情报权重" : aiModelBrier < aiMarketBrier ? "融合在当前严格样本优于市场基线，仍需滚动未来验证" : "融合未优于同场市场基线，应收缩情报权重",
  },
  byLeague,
  decisionRows: selected.map((row) => ({
    matchKey: row.matchKey, snapshotId: row.snapshotId, decisionPolicy: row.decisionPolicy, id: row.id, league: row.league,
    home: row.home, away: row.away, kickoffAt: row.kickoffAt, capturedAt: row.capturedAt, resultDate: row.result?.date,
    actualScore: row.actualScore, actualHad: row.actualHad, predictedHad: row.had[0]?.score || "", hadProbability: row.had[0]?.probability || null,
    scoreTop1: row.scores[0]?.score || "", scoreTop3Hit: row.scores.slice(0, 3).some((item) => item.score === row.actualScore),
    totalTop2: row.total.slice(0, 2).map((item) => item.score), actualTotal: row.actualTotal,
    intelligenceCoverage: row.intelligenceCoverage,
  })),
};

const issueRows = [
  ["高", "历史格式混用", `${summary.inventory.legacySnapshotCount}/${summary.inventory.snapshotCount} 个快照仍为旧格式`, "旧快照缺少官方ID、完整比分分布、总进球/半全场等字段，不能与新版样本等权训练"],
  [summary.inventory.fallbackDecisionRows ? "高" : "低", "决策时点不可核验", `${summary.inventory.fallbackDecisionRows}/${summary.inventory.selectedDecisionRows} 场不是严格开赛前90分钟样本`, "避免赛中或临近开赛数据混入赛前评估"],
  [summary.completeness.marketHadBaseline.rate < 80 ? "高" : "中", "市场基线缺失", `${summary.completeness.marketHadBaseline.rate}% 行保存了可比较的去水胜平负基线`, "没有同场同刻市场基线就无法证明模型增益"],
  [summary.completeness.validIntelligenceEvidence.rate < 50 ? "中" : "低", "情报证据覆盖有限", `${summary.completeness.validIntelligenceEvidence.rate}% 行包含通过时效门控的情报证据`, "AI应只在证据完整且未来验证有增益时改变数值"],
];

const metricLine = (name, metric) => `| ${name} | ${metric.eligible} | ${metric.rate ?? "—"}% |`;
const markdown = `# 预测历史与模型改进审计\n\n生成时间：${summary.generatedAt}\n\n## 数据口径\n\n${summary.grain}。赛果来自当前站点的赛果接口，并优先按官方比赛 ID 对齐。\n\n## 样本概览\n\n- 已读取 ${summary.inventory.snapshotCount} 个快照、${summary.inventory.rawPredictionRows} 行预测。\n- 赛果可对齐的独立比赛 ${summary.inventory.uniqueSettledMatches} 场；最终评估 ${summary.inventory.selectedDecisionRows} 场。\n- 严格决策时点样本 ${summary.inventory.strictDecisionRows} 场；回退或时间不可核验 ${summary.inventory.fallbackDecisionRows} 场。\n\n## 当前表现（仅作诊断，不代表未来保证）\n\n| 指标 | 可评估场次 | 命中率 |\n|---|---:|---:|\n${metricLine("比分首选", summary.overall.scoreTop1)}\n${metricLine("比分前三覆盖", summary.overall.scoreTop3)}\n${metricLine("胜平负首选", summary.overall.hadTop1)}\n${metricLine("让球胜平负首选", summary.overall.hhadTop1)}\n${metricLine("总进球首选", summary.overall.totalTop1)}\n${metricLine("总进球前二覆盖", summary.overall.totalTop2)}\n${metricLine("半全场首选", summary.overall.halfFullTop1)}\n\n胜平负概率质量：模型 Brier ${summary.overall.modelBrier ?? "—"}、Log Loss ${summary.overall.modelLogLoss ?? "—"}；同样本市场基线 Brier ${summary.overall.marketBrier ?? "—"}、Log Loss ${summary.overall.marketLogLoss ?? "—"}。\n\n## 数据质量风险\n\n| 严重度 | 问题 | 证据 | 影响 |\n|---|---|---|---|\n${issueRows.map((row) => `| ${row.join(" | ")} |`).join("\n")}\n\n## 情报融合现状\n\n可比较样本 ${summary.aiContribution.comparableMatches} 场；融合 Brier ${summary.aiContribution.fusedBrier ?? "—"}，市场基线 ${summary.aiContribution.marketBaselineBrier ?? "—"}，差值 ${summary.aiContribution.brierDelta ?? "—"}（负值更好）。${summary.aiContribution.interpretation}。\n\n## 按联赛（样本很小时只用于发现问题）\n\n| 联赛 | 场次 | 胜平负 | 比分前三 | 总进球前二 | Brier |\n|---|---:|---:|---:|---:|---:|\n${byLeague.map((row) => `| ${row.league} | ${row.matches} | ${row.hadTop1.rate ?? "—"}% | ${row.scoreTop3.rate ?? "—"}% | ${row.totalTop2.rate ?? "—"}% | ${row.modelBrier ?? "—"} |`).join("\n")}\n\n## 优先改进清单\n\n1. **先修数据口径**：训练和评估只接受官方比赛 ID、有效 kickoffAt、不可变输入快照、可追溯决策时点；旧格式只展示，不进入正式调参。\n2. **建立真正的模型基线**：同场同刻比较“市场去水概率、纯盘口比分模型、AI融合模型”，使用 Brier、Log Loss、校准分桶和覆盖率，不只看命中率。\n3. **情报权重改为证据与历史增益双门控**：保留最高 40% 上限；样本不足或未来测试不优于市场时自动收缩到 0。\n4. **低比分相关修正**：在独立泊松之外加入 Dixon–Coles 低比分相关项，并用训练区间估计参数；所有玩法仍由同一完整比分分布派生。\n5. **分层校准而非联赛硬拟合**：总体参数为主，联赛/盘口深度/提前量只在样本足够时小幅偏移，避免小联赛样本过拟合。\n6. **加入数据漂移与新鲜度闸门**：赔率源过期、玩法缺失、比赛映射不确定、开赛时间无效时停止可执行推荐，但保留研究展示。\n7. **UI改为决策工作台**：默认展示今天需要处理的比赛、数据状态、模型版本、变动原因与风险；高级诊断折叠；预测、推荐、复盘使用同一设计变量与字段命名。\n\n## 限制\n\n当前历史跨度较短，且旧快照字段不全。任何参数升级都应先以“候选版本”影子运行，积累未参与调参的未来样本后再升级为正式模型。\n`;

await mkdir(OUTPUT_DIRECTORY, {recursive: true});
await writeFile(join(OUTPUT_DIRECTORY, "prediction-history-audit.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await writeFile(join(OUTPUT_DIRECTORY, "prediction-history-audit.md"), markdown, "utf8");
console.log(JSON.stringify({json: join(OUTPUT_DIRECTORY, "prediction-history-audit.json"), markdown: join(OUTPUT_DIRECTORY, "prediction-history-audit.md"), inventory: summary.inventory, overall: summary.overall, aiContribution: summary.aiContribution}, null, 2));
