import {MARKET_META} from "./purchase-plan-engine";
import {calculateTicketEconomics} from "./ticket-economics.js";
import {RESEARCH_MARKETS} from "./recommendation-policy.js";

export type RecommendationMarket = keyof typeof MARKET_META;
export type PricedSelection = {score: string; probability: number; odd: number | null; oddsReason?: string};
export type OfficialRecommendationMatch = {
  officialMatchId?: string; matchId?: string; salesDate?: string; matchDate?: string;
  kickoffAt?: string; matchStatus?: string; updatedAt?: string;
  marketOdds?: Record<string, Array<number | string> | null>;
  marketStatus?: Record<string, string>;
  marketEligibility?: Record<string, {
    marketCode?: string; qualification?: string; salesStatus?: string;
    allowedPassCounts?: number[]; cutoffAt?: string | null; handicap?: string | null;
  }>;
};

const normalizedPick = (market: RecommendationMarket, value: string) => {
  const pick = value.trim().replace(/\s/g, "").replace(/：/g, ":");
  if (market === "total" && /^(?:7|7\+)(?:球)?$/.test(pick)) return "7+球";
  return pick;
};

/** Only quote the current official market, never model odds or a historical snapshot. */
export function priceRecommendationSelections(
  points: Array<{score: string; probability: number}>,
  market: RecommendationMarket,
  official: OfficialRecommendationMatch,
): PricedSelection[] {
  const meta = MARKET_META[market], values = official.marketOdds?.[meta.name];
  if(RESEARCH_MARKETS.has(market))return points.map(point=>({...point,odd:null,oddsReason:"半全场仅供研究，暂停新组合"}));
  const unavailable = ["failed", "unavailable"].includes(official.marketStatus?.[meta.name] || "");
  return points.map(point => {
    const index = meta.labels.indexOf(normalizedPick(market, point.score));
    const raw = index >= 0 && !unavailable ? values?.[index] : undefined;
    const odd = typeof raw === "number" || typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
    if (Number.isFinite(odd) && odd >= 1) return {...point, odd};
    return {...point, odd: null, oddsReason: index < 0 ? "体彩没有该独立选项" : "当前体彩赔率缺失"};
  });
}

type ReturnLeg = {matchKey: string; market: RecommendationMarket; scores: PricedSelection[]};

/** One N串1 group: all per-match choices expand into individual 2-yuan bets. */
export function calculateRecommendationReturns(items: ReturnLeg[]) {
  if (!items.length || items.length > 8 || new Set(items.map(item => item.matchKey)).size !== items.length) {
    throw new Error("组合需要 1–8 场不同的比赛");
  }
  if (items.some(item => !item.scores.length || items.length > MARKET_META[item.market].maxPass ||
    new Set(item.scores.map(score => normalizedPick(item.market, score.score))).size !== item.scores.length)) {
    throw new Error("组合包含重复选项、空选项或超出玩法关数限制");
  }
  const missingOdds = items.flatMap(item => item.scores.filter(score => score.odd === null || !Number.isFinite(score.odd) || score.odd <= 1)
    .map(score => `${item.matchKey} ${MARKET_META[item.market].name} ${score.score}`));
  return {...calculateTicketEconomics(items),missingOdds};
}
