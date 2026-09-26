import {MARKET_META} from "./purchase-plan-engine";

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
type Fraction = {numerator: bigint; denominator: bigint};
const integer = BigInt;
function decimalFraction(value: number): Fraction {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,6})?$/.test(text) || value < 1) throw new Error("体彩赔率格式无效");
  const [whole, decimal = ""] = text.split(".");
  return {numerator: integer(whole + decimal), denominator: integer(10) ** integer(decimal.length)};
}
function multiply(values: number[]): Fraction {
  return values.map(decimalFraction).reduce((result, value) => ({
    numerator: result.numerator * value.numerator,
    denominator: result.denominator * value.denominator,
  }), {numerator: integer(2), denominator: integer(1)});
}

// Official rule: inspect the third decimal; on 5 retain an even second decimal.
// https://m.sporttery.cn/bzzx/20210207/3273604.html?gid=3
function officialBonusCents(value: Fraction, cap: number) {
  if (value.numerator >= integer(cap) * value.denominator) return cap * 100;
  const thousandths = value.numerator * integer(1000) / value.denominator;
  let cents = thousandths / integer(10);
  const digit = Number(thousandths % integer(10));
  if (digit > 5 || digit === 5 && cents % integer(2) === integer(1)) cents += integer(1);
  return Number(cents);
}

/** One N串1 group: all per-match choices expand into individual 2-yuan bets. */
export function calculateRecommendationReturns(items: ReturnLeg[]) {
  if (!items.length || items.length > 8 || new Set(items.map(item => item.matchKey)).size !== items.length) {
    throw new Error("组合需要 1–8 场不同的比赛");
  }
  if (items.some(item => !item.scores.length || items.length > MARKET_META[item.market].maxPass ||
    new Set(item.scores.map(score => normalizedPick(item.market, score.score))).size !== item.scores.length)) {
    throw new Error("组合包含重复选项、空选项或超出玩法关数限制");
  }
  const betCount = items.reduce((count, item) => count * item.scores.length, 1);
  const totalStake = betCount * 2;
  const missingOdds = items.flatMap(item => item.scores.filter(score => score.odd === null || !Number.isFinite(score.odd) || score.odd < 1)
    .map(score => `${item.matchKey} ${MARKET_META[item.market].name} ${score.score}`));
  const base = {unitStake: 2, multiplier: 1, betCount, totalStake, worstCaseProfit: -totalStake, missingOdds};
  if (missingOdds.length) return {...base, status: "unavailable" as const};
  const minimum = multiply(items.map(item => Math.min(...item.scores.map(score => score.odd!))));
  const maximum = multiply(items.map(item => Math.max(...item.scores.map(score => score.odd!))));
  const bonusCap = items.length === 1 ? 100000 : items.length <= 3 ? 200000 : items.length <= 5 ? 500000 : 1000000;
  const minCents = officialBonusCents(minimum, bonusCap), maxCents = officialBonusCents(maximum, bonusCap);
  // Expand the purchased ticket, including the zero payout of every missed bet.
  // Probabilities are percentages; different fixtures use the independence assumption.
  const validProbabilities = items.every(item => item.scores.every(score =>
    typeof score.probability === "number" && Number.isFinite(score.probability) &&
    score.probability >= 0 && score.probability <= 100) &&
    item.scores.reduce((sum, score) => sum + score.probability, 0) <= 100 + 1e-8);
  let expectedReturn: number | null = null;
  if (validProbabilities) {
    let total = 0;
    const walk = (index: number, odds: number[], probability: number) => {
      if (index === items.length) {
        total += probability * officialBonusCents(multiply(odds), bonusCap) / 100;
        return;
      }
      for (const score of items[index].scores) {
        walk(index + 1, [...odds, score.odd!], probability * score.probability / 100);
      }
    };
    walk(0, [], 1);
    expectedReturn = total;
  }
  return {...base, status: "ready" as const, bonusCap,
    expectedReturn,
    minCombinedOdd: Number(minimum.numerator) / Number(minimum.denominator) / 2,
    maxCombinedOdd: Number(maximum.numerator) / Number(maximum.denominator) / 2,
    minWinningReturn: minCents / 100, maxWinningReturn: maxCents / 100,
    minWinningProfit: (minCents - totalStake * 100) / 100,
    maxWinningProfit: (maxCents - totalStake * 100) / 100,
    capped: maximum.numerator > integer(bonusCap) * maximum.denominator,
  };
}
