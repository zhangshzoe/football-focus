import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { generatePurchasePlans } from "../app/purchase-plan-engine.js";

const slot = process.argv[2];
if (!/^([01]\d|2[0-3])[0-5]\d$/.test(slot || "")) throw new Error("快照时段必须是 HHmm，例如 2130 或 2230。");
const baseUrl = process.env.FOOTBALL_FOCUS_URL || "http://localhost:3000";
const shanghaiDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const directory = join(process.cwd(), "data", "prediction-snapshots");
const date = shanghaiDate(), snapshotId = `${date}-${slot}`;
const rawOutput = join(directory, `${date}_${slot}.raw.json`), legacyOutput = join(directory, `${date}_${slot}.json`);
const scheduledAt = `${date}T${slot.slice(0, 2)}:${slot.slice(2)}:00+08:00`;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
const exists = async path => { try { await access(path, constants.F_OK); return true; } catch { return false; } };
const writeOnce = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
const kickoffMs = reports => Math.min(...reports.map(report => Date.parse(report.kickoffAt || report.time || "")).filter(Number.isFinite));
const timingAt = (createdAt, reports) => { const first = kickoffMs(reports); return Number.isFinite(first) ? (Date.parse(createdAt) < first ? "pre_match" : "in_play") : "unknown"; };

async function supplementsFor(baseSnapshotId) {
  const records = [];
  for (const name of (await readdir(directory).catch(() => [])).filter(name => name.includes(".supplement."))) {
    try { const record = JSON.parse(await readFile(join(directory, name), "utf8")); if (record.baseSnapshotId === baseSnapshotId) records.push(record); } catch { /* 跳过损坏的补充记录。 */ }
  }
  return records;
}

async function appendAiReview(raw, supplements) {
  if (supplements.some(record => record.kind === "ai-review") || !raw.version?.predictionId || raw.reports.some(report => report.predictionId !== raw.version.predictionId)) return null;
  try {
    const response = await fetch(`${baseUrl}/api/predictions/ai`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: raw.version, reports: raw.reports }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.version?.predictionId || !Array.isArray(data.reports) || !data.reports.length) return null;
    const aiCompletedAt = new Date().toISOString(), decisionTiming = timingAt(aiCompletedAt, raw.reports);
    const record = { recordId: `ai-${raw.snapshotId}-${digest([data.version.predictionId, aiCompletedAt])}`, kind: "ai-review", baseSnapshotId: raw.snapshotId, inputPredictionId: raw.predictionId, outputPredictionId: data.version.predictionId, createdAt: aiCompletedAt, aiCompletedAt, decisionTiming, includedInPreMatchEvaluation: decisionTiming === "pre_match", provider: `${data.provider || "AI"}${data.model ? ` · ${data.model}` : ""}`, version: data.version, reports: data.reports };
    await writeOnce(join(directory, `${date}_${slot}.supplement.ai.${record.recordId}.json`), record);
    return record;
  } catch { return null; }
}

async function appendPurchasePlans(raw, supplements, aiRecord) {
  if (slot !== "1700" || supplements.some(record => record.kind === "purchase-plans")) return null;
  const reports = aiRecord?.reports || raw.reports, predictionId = aiRecord?.outputPredictionId || raw.predictionId, createdAt = new Date().toISOString(), decisionTiming = timingAt(createdAt, reports);
  const plans = generatePurchasePlans({ date, reports, officialMatches: raw.officialMatches || [], generatedAt: createdAt });
  const record = { recordId: `plans-${raw.snapshotId}-${digest([predictionId, createdAt])}`, kind: "purchase-plans", baseSnapshotId: raw.snapshotId, inputPredictionId: predictionId, createdAt, decisionTiming, includedInPreMatchEvaluation: decisionTiming === "pre_match", plans };
  await writeOnce(join(directory, `${date}_${slot}.supplement.plans.${record.recordId}.json`), record);
  return record;
}

await mkdir(directory, { recursive: true });
if (await exists(rawOutput) || await exists(legacyOutput)) {
  const path = await exists(rawOutput) ? rawOutput : legacyOutput, raw = JSON.parse(await readFile(path, "utf8"));
  raw.snapshotId ||= snapshotId;
  const supplements = await supplementsFor(raw.snapshotId), ai = await appendAiReview(raw, supplements), plans = await appendPurchasePlans(raw, supplements, ai);
  console.log(JSON.stringify({ status: "exists", raw: path, unchanged: true, supplementsAdded: [ai, plans].filter(Boolean).map(item => item.kind) }));
  process.exit(0);
}

const matchesResponse = await fetch(`${baseUrl}/api/sporttery`, { cache: "no-store" }), matchesData = await matchesResponse.json();
if (!matchesResponse.ok) throw new Error(matchesData.error || "体彩比赛数据读取失败");
const matches = (Array.isArray(matchesData.matches) ? matchesData.matches : []).filter(match => String(match.salesDate || match.matchDate || "").slice(0, 10) === date);
if (!matches.length) throw new Error("当前没有可保存的真实比赛数据");
if (matches.some(match => !match.matchId || match.isMock)) throw new Error("存在缺少官方 matchId 或 mock 标记的比赛，拒绝保存快照");

const predictionResponse = await fetch(`${baseUrl}/api/predictions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ matches: matches.map(match => ({ id: match.id, matchId: match.matchId, officialMatchId: match.officialMatchId || match.matchId, salesDate: match.salesDate, kickoffAt: match.kickoffAt, homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId, homeTeamCode: match.homeTeamCode, awayTeamCode: match.awayTeamCode, league: match.league, time: match.time, matchDate: match.matchDate, home: match.home, away: match.away, odds: match.odds, handicap: match.handicap, hhadOdds: match.marketOdds?.["让球胜平负"], matchStatus: match.matchStatus, marketEligibility: match.marketEligibility, updatedAt: match.updatedAt, isMock: false })) }) }), predictionData = await predictionResponse.json();
if (!predictionResponse.ok) throw new Error(predictionData.error || "盘口预测读取失败");
const rawReports = Array.isArray(predictionData.reports) ? predictionData.reports : [], realMatchIds = new Set(matches.map(match => String(match.officialMatchId || match.matchId)));
if (rawReports.some(report => report.isMock)) throw new Error("预测结果包含 mock，拒绝保存快照");
const reports = rawReports.filter(report => report.id && report.home && report.away && report.officialMappingStatus === "verified" && realMatchIds.has(String(report.officialMatchId)));
if (!reports.length) throw new Error("预测结果为空，或没有可与当前官方竞彩清单确认主客队的比赛，拒绝保存快照");
const incomplete = reports.filter(report => !report.fullScoreDistribution?.length || !report.probabilities || !report.marketSignal?.modeledTotalGoals?.length || !report.marketSignal?.modeledHalfFull?.length || (report.marketEligibility?.["让球胜平负"]?.qualification === "qualified" && !report.marketSignal?.modeledHhad?.length));
if (incomplete.length) throw new Error(`有 ${incomplete.length} 场缺少其官方可售玩法所需的预测字段，拒绝保存快照`);

const capturedAt = new Date().toISOString(), upstreamUpdatedAt = predictionData.fetchedAt || matchesData.fetchedAt || capturedAt;
const immutableReports = reports.map(report => ({ ...report, sourceFetchedAt:upstreamUpdatedAt, layers: { oddsBaseline: { fullScoreDistribution: report.oddsScores || report.fullScoreDistribution, probabilities: Array.isArray(report.marketProbabilities)&&report.marketProbabilities.length===3?{home:report.marketProbabilities[0],draw:report.marketProbabilities[1],away:report.marketProbabilities[2]}:undefined }, intelligenceOutput: { scores: report.intelligenceScores || [], coverage: report.intelligenceCoverage || 0, summary: report.aiSummary || "", risk: report.aiRisk || "", evidence: report.intelligenceEvidence?.records || [] }, fusionOutput: { fullScoreDistribution: report.fullScoreDistribution, probabilities: report.probabilities, hhad: report.marketSignal?.modeledHhad || [], totalGoals: report.marketSignal?.modeledTotalGoals || [], halfFull: report.marketSignal?.modeledHalfFull || [] } }, inputHash: report.inputSnapshotId || predictionData.version?.inputSnapshotId || "", parameters: { baseModelVersion: report.baseModelVersion, calibrationVersion: report.calibrationVersion, predictionId: report.predictionId } }));
const raw = { schemaVersion: 2, recordType: "raw-prediction-snapshot", snapshotId, immutable: true, predictionId: predictionData.predictionId, version: predictionData.version, scheduledAt, scheduledTime: slot, capturedAt, upstreamUpdatedAt, sourceFetchedAt: upstreamUpdatedAt, decisionTiming: timingAt(capturedAt, immutableReports), source: { sporttery: matchesData.source || "中国体育彩票竞彩网", market: predictionData.sourceUrl || "" }, sourceMatchCount: matches.length, inputHash: predictionData.version?.inputSnapshotId || digest(matches), modelVersion: predictionData.methodology || "多盘口交叉校准模型", officialMatches: matches, reports: immutableReports };
await writeOnce(rawOutput, raw);
const supplements = [], ai = await appendAiReview(raw, supplements); if (ai) supplements.push(ai);
const plans = await appendPurchasePlans(raw, supplements, ai);
console.log(JSON.stringify({ status: "saved", output: rawOutput, immutable: true, scheduledAt, capturedAt, matches: reports.length, supplements: [ai, plans].filter(Boolean).map(item => item.kind) }));
