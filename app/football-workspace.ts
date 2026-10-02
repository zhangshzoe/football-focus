import type { AiEvidenceSummary } from "./prediction-config";

export type Pick = { matchId: string; market: string; label: string; odd: number };
export type Rec = {
  id: number;
  date?: string;
  match: string;
  type?: string;
  pick: string;
  stake: number;
  odd: number;
  result: "待定" | "命中" | "未中";
  note: string;
};
export const markets = {
  胜平负: ["胜", "平", "负"],
  让球胜平负: ["让胜", "让平", "让负"],
  比分: [
    "1:0",
    "2:0",
    "2:1",
    "3:0",
    "3:1",
    "3:2",
    "4:0",
    "4:1",
    "4:2",
    "5:0",
    "5:1",
    "5:2",
    "胜其他",
    "0:0",
    "1:1",
    "2:2",
    "3:3",
    "平其他",
    "0:1",
    "0:2",
    "1:2",
    "0:3",
    "1:3",
    "2:3",
    "0:4",
    "1:4",
    "2:4",
    "0:5",
    "1:5",
    "2:5",
    "负其他",
  ],
  总进球数: ["0", "1", "2", "3", "4", "5", "6", "7+"],
  半全场: ["胜胜", "胜平", "胜负", "平胜", "平平", "平负", "负胜", "负平", "负负"],
} as const;
export type Market = keyof typeof markets;
export type MarketState = "available" | "unavailable" | "failed";
export type DataState = "loading" | "success" | "stale" | "empty" | "error";
export type PoolStatus = Record<
  string,
  { status: "success" | "failed"; matchCount: number | null; error?: string }
>;
export type MarketEligibility = {
  marketCode: string;
  handicap: string | null;
  salesStatus: string;
  supportsSingle: boolean;
  allowedPassCounts: number[];
  cutoffAt: string | null;
  ruleVersion: string;
  qualification: string;
};
export type Match = {
  marketSource?: Partial<Record<Market, { observedAt: string }>>;
  quoteState?: "stale" | "fresh";
  id: string;
  league: string;
  time: string;
  home: string;
  away: string;
  odds?: number[] | null;
  form: string[];
  tag: string;
  risk: string;
  matchId?: string;
  officialMatchId?: string;
  salesDate?: string;
  kickoffAt?: string;
  homeTeamId?: string;
  awayTeamId?: string;
  homeTeamCode?: string;
  awayTeamCode?: string;
  matchDate?: string;
  homeRank?: string;
  awayRank?: string;
  sellStatus?: number;
  matchStatus?: string;
  remark?: string;
  handicap?: string | null;
  updatedAt?: string;
  marketOdds?: Partial<Record<Market, number[] | null>>;
  marketStatus?: Partial<Record<Market, MarketState>>;
  marketEligibility?: Partial<Record<Market, MarketEligibility>>;
};
export type OddsPoint = {
  updateDate?: string;
  updateTime?: string;
  h?: string;
  d?: string;
  a?: string;
  goalLine?: string;
  hf?: string;
  df?: string;
  af?: string;
};
export type DetailData = {
  sourceUrl: string;
  match?: { matchDateTime?: string; homeTeamShortName?: string; awayTeamShortName?: string };
  oddsHistory?: Array<{
    hadList?: OddsPoint[];
    hhadList?: OddsPoint[];
    ttgList?: Record<string, string>[];
    hafuList?: Record<string, string>[];
    crsList?: Record<string, string>[];
  }>;
};
export type MatchResult = {
  id: string;
  matchId: string;
  date: string;
  league: string;
  home: string;
  away: string;
  halfScore: string;
  fullScore: string;
  handicap: string;
  status: string;
};
export const handicapText = (value: unknown) => {
  const text = String(value ?? "").trim();
  if (!text) return "—";
  const numeric = Number(text);
  return Number.isFinite(numeric) ? `${numeric > 0 ? "+" : ""}${numeric}` : text;
};
export type CompanyPredictionOdds = {
  companyId: number;
  company: string;
  win: number;
  draw: number;
  lose: number;
  handicap: number;
  homePrice: number;
  awayPrice: number;
  total: number;
  overPrice: number;
  underPrice: number;
  firstWin: number;
  firstDraw: number;
  firstLose: number;
  firstHandicap: number;
  firstHomePrice: number;
  firstAwayPrice: number;
  firstTotal: number;
  firstOverPrice: number;
  firstUnderPrice: number;
};
export type ScorePrediction = { score: string; probability: number };
export type PredictionVersion = {
  predictionId: string;
  inputSnapshotId: string;
  baseModelVersion: string;
  calibrationVersion: string;
  aiReviewVersion?: string | null;
  reviewForPredictionId?: string;
  parentPredictionId?: string | null;
  generatedAt: string;
  aiReviewedAt?: string;
};
export type PredictionReport = {
  modelInput?: unknown;
  modelParameters?: unknown;
  dataQuality?: unknown;
  marketTotalGoalProbabilities?: number[];
  sourceFetchedAt?: string;
  predictionId?: string;
  inputSnapshotId?: string;
  baseModelVersion?: string;
  calibrationVersion?: string;
  predictionGeneratedAt?: string;
  fullScoreDistribution?: ScorePrediction[];
  shadowFullScoreDistribution?: ScorePrediction[];
  shadowHadProbabilities?: ScorePrediction[];
  appliedIntelligenceWeight?: number;
  intelligenceEvidence?: {
    records: Array<{ type: string; sourceUrl: string; observedAt: string; summary?: string }>;
  };
  id: string;
  externalDisplayId?: string;
  researchOnly?: boolean;
  officialMatchId?: string;
  salesDate?: string;
  kickoffAt?: string;
  homeTeamId?: string;
  awayTeamId?: string;
  homeTeamCode?: string;
  awayTeamCode?: string;
  officialMappingStatus?: string;
  mappingReason?: string;
  marketEligibility?: Partial<Record<Market, MarketEligibility>>;
  league: string;
  time: string;
  matchDate?: string;
  home: string;
  away: string;
  matchStatus?: string;
  isMock?: boolean;
  sourceUpdatedAt?: string;
  companies: CompanyPredictionOdds[];
  marketProbabilities?: number[];
  probabilities: { home: number; draw: number; away: number };
  consensus: { handicap: number; totalLine: number; agreement: string };
  marketSignal?: {
    direction: string;
    strength: number;
    probabilityShifts: number[];
    fairOdds: number[];
    hadEv?: number[];
    hhadEv?: number[];
    evThreshold?: number;
    institutionAction?: string;
    handicapExpectation?: string;
    firstHandicap: number;
    handicapChange: number;
    narrative: string;
    officialOdds: number[];
    officialHandicap: string;
    officialHhadOdds: number[];
    officialHhadFair: number[];
    modeledHhad: number[];
    hhadAvailable?: boolean;
    modeledTotalGoals?: number[];
    modeledHalfFull?: number[];
    asianHomeProbability: number;
    asianAwayProbability: number;
    asianMovement: number;
    overProbability: number;
    fitAgreement: string;
    handicapMeaning: string;
  };
  expectedGoals: { home: number; away: number };
  scores: ScorePrediction[];
  oddsScores?: ScorePrediction[];
  intelligenceScores?: ScorePrediction[];
  intelligenceCoverage?: number;
  hadProbabilities?: ScorePrediction[];
  hhadProbabilities?: ScorePrediction[];
  totalGoalProbabilities?: ScorePrediction[];
  missingCompanies: number[];
  aiSummary?: string;
  aiRisk?: string;
  aiEvidenceSummary?: AiEvidenceSummary;
  aiReviewMode?: string;
  contextProof?: unknown;
};
export const shanghaiDate = (offsetDays = 0) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + offsetDays * 86400000));
// 所有赛事筛选与场次排序按竞彩开售日（周五001 等）而非实际开赛日。
// 因此周五深夜开赛、周六凌晨结束的周五009，仍属于“周五场次”。
export const matchDateKey = (match: { salesDate?: string; matchDate?: string; time: string }) => {
  const raw = String(match.salesDate || match.matchDate || match.time || "");
  const parts = raw.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  return parts ? `${parts[1]}-${parts[2].padStart(2, "0")}-${parts[3].padStart(2, "0")}` : "";
};
export const compareMatchesByDateAndSequence = (left: Match, right: Match) => {
  const dateOrder = matchDateKey(left).localeCompare(matchDateKey(right));
  if (dateOrder) return dateOrder;
  const sequenceOrder = left.id.localeCompare(right.id, "zh-CN", {
    numeric: true,
    sensitivity: "base",
  });
  if (sequenceOrder) return sequenceOrder;
  return String(left.kickoffAt || left.time).localeCompare(String(right.kickoffAt || right.time));
};
export const matchDateLabel = (date: string) => {
  const formatted = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${date}T12:00:00+08:00`));
  return `${formatted.replace("星期", "周")}场次`;
};
export const recordDate = (record: Rec) =>
  record.date ||
  (record.id > 1_000_000_000_000
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(record.id))
    : "");
export const SPORTTERY_CACHE_KEY = "ff-sporttery-official-cache-v1";
export class OfficialAccessBlockedError extends Error {}
export class OfficialManifestUnavailableError extends Error {}
export const matchCacheKey = (match: Match) =>
  `${match.salesDate || match.matchDate || ""}:${match.officialMatchId || match.matchId || match.id}`;
export const mergeOfficialMatches = (current: Match[], incoming: Match[]) => {
  const merged = new Map<string, Match>(
    current.map((match) => [matchCacheKey(match), { ...match, quoteState: "stale" }]),
  );
  incoming.forEach((match) => {
    const key = matchCacheKey(match),
      previous = merged.get(key);
    merged.set(
      key,
      previous
        ? {
            ...previous,
            ...match,
            quoteState: "fresh",
            marketOdds: {
              ...previous.marketOdds,
              ...Object.fromEntries(
                Object.entries(match.marketOdds || {}).filter(
                  ([, value]) => Array.isArray(value) && value.some((odd) => Number(odd) > 0),
                ),
              ),
            },
            marketStatus: { ...previous.marketStatus, ...match.marketStatus },
            marketEligibility: { ...previous.marketEligibility, ...match.marketEligibility },
          }
        : { ...match, quoteState: "fresh" },
    );
  });
  return Array.from(merged.values());
};
export const oddsFor = (game: Match | undefined, market: Market): number[] | null => {
  if (
    game?.quoteState === "stale" ||
    game?.marketStatus?.[market] !== "available" ||
    game.marketEligibility?.[market]?.qualification !== "qualified"
  )
    return null;
  const candidate = game?.marketOdds?.[market] ?? (market === "胜平负" ? game?.odds : null);
  if (
    !Array.isArray(candidate) ||
    !candidate.some((value) => Number.isFinite(Number(value)) && Number(value) > 0)
  )
    return null;
  return candidate.map((value) =>
    Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0,
  );
};
export const fairMarketPoints = (labels: string[], odds: number[]) => {
  const raw = odds.map((value) => (value > 1 ? 1 / value : 0)),
    total = raw.reduce((sum, value) => sum + value, 0);
  return total > 0
    ? labels.map((score, index) => ({ score, probability: (raw[index] / total) * 100 }))
    : [];
};

/** Display current quotes only for one exact official fixture and one fresh qualified pool. */
export function currentOfficialOdds(
  row: {
    officialMatchId?: string;
    salesDate?: string;
    matchDate?: string;
    time: string;
    kickoffAt?: string;
    home: string;
    away: string;
  },
  matches: Match[],
  market: Market,
  handicap?: string,
): number[] {
  const date = matchDateKey(row),
    kickoff = Date.parse(row.kickoffAt || "");
  if (!row.officialMatchId || !date || !Number.isFinite(kickoff)) return [];
  const found = matches.filter(
    (match) =>
      String(match.officialMatchId || match.matchId || "") === String(row.officialMatchId) &&
      matchDateKey(match) === date &&
      match.home === row.home &&
      match.away === row.away &&
      Date.parse(match.kickoffAt || "") === kickoff,
  );
  if (found.length !== 1) return [];
  const match = found[0],
    observed = Date.parse(match.marketSource?.[market]?.observedAt || ""),
    now = Date.now();
  if (!Number.isFinite(observed) || observed > now || now - observed > 300000) return [];
  if (market === "让球胜平负" && handicapText(match.handicap) !== handicapText(handicap)) return [];
  return oddsFor(match, market) || [];
}
