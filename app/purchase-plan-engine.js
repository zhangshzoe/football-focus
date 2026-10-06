import {calculateTicketEconomics,ticketSensitivity,summarizeTicketPortfolio,settleTicket,ticketFixtureKey} from "./ticket-economics.js";
import {assessRecommendation,selectRecommendationPortfolio,normalizeRecommendationPolicy,DEFAULT_RECOMMENDATION_POLICY,RESEARCH_MARKETS} from "./recommendation-policy.js";
import {mergePurchaseBatches,purchaseBatchIdentity} from "./purchase-batch-policy.js";
import {summarizePurchaseHistorySamples} from "./purchase-history-samples.js";
import {calculatePortfolioScenarioRisk} from "./portfolio-scenario-risk.js";
export const PURCHASE_PLAN_STORAGE_KEY = "ff-daily-purchase-plans-v1";
export const PURCHASE_PLAN_VERSION = 19;
export const PURCHASE_DECISION_POLICY = "probability-first-return-constrained-v4";
export const PURCHASE_PLAN_DEFINITIONS = [
  {
    id: "score-double-3",
    title: "比分双选3串1",
    rule: "每场2个比分 · 3串1",
    markets: ["score"],
    matches: 3,
    selections: 2,
  },
  {
    id: "score-single-2",
    title: "比分单选2串1",
    rule: "每场1个比分 · 2串1",
    markets: ["score"],
    matches: 2,
    selections: 1,
  },
  {
    id: "score-double-2",
    title: "比分双选2串1",
    rule: "每场2个比分 · 2串1",
    markets: ["score"],
    matches: 2,
    selections: 2,
  },
  {
    id: "score-single-3",
    title: "比分单选3串1",
    rule: "每场1个比分 · 3串1",
    markets: ["score"],
    matches: 3,
    selections: 1,
  },
  {
    id: "total-double-3",
    title: "总进球双选3串1",
    rule: "每场2个进球数 · 3串1",
    markets: ["total"],
    matches: 3,
    selections: 2,
  },
  {
    id: "total-double-2",
    title: "总进球双选2串1",
    rule: "每场2个进球数 · 2串1",
    markets: ["total"],
    matches: 2,
    selections: 2,
  },
  {
    id: "total-single-2",
    title: "总进球单选2串1",
    rule: "每场1个进球数 · 2串1",
    markets: ["total"],
    matches: 2,
    selections: 1,
  },
  {
    id: "draw-or-handicap-draw-2",
    title: "平/让平单选2串1",
    rule: "平或让平 · 2串1",
    markets: ["had", "hhad"],
    matches: 2,
    selections: 1,
    allowedPicks: ["平", "让平"],
  },
  {
    id: "draw-or-handicap-draw-3",
    title: "平/让平单选3串1",
    rule: "平或让平 · 3串1",
    markets: ["had", "hhad"],
    matches: 3,
    selections: 1,
    allowedPicks: ["平", "让平"],
  },
  {
    id: "result-mixed-3",
    title: "赛果混合单选3串1",
    rule: "胜平负/让球胜平负 · 3串1",
    markets: ["had", "hhad"],
    matches: 3,
    selections: 1,
    mixed: true,
  },
  {
    id: "result-mixed-4",
    title: "赛果混合单选4串1",
    rule: "胜平负/让球胜平负 · 4串1",
    markets: ["had", "hhad"],
    matches: 4,
    selections: 1,
    mixed: true,
  },
  {
    id: "result-mixed-5",
    title: "赛果混合单选5串1",
    rule: "胜平负/让球胜平负 · 5串1",
    markets: ["had", "hhad"],
    matches: 5,
    selections: 1,
    mixed: true,
  },
  {
    id: "had-safe-2",
    title: "胜平负单选2串1",
    rule: "每场首选≥50% · 2串1",
    markets: ["had"],
    matches: 2,
    selections: 1,
    minLegProbability: 50,
  },
  {
    id: "tenfold-safe-2",
    title: "命中净利≥10倍 A · 单选2串1",
    rule: "基础投入2元 · 命中净利至少20元 · 2串1",
    markets: ["had", "hhad", "total", "halfFull"],
    matches: 2,
    selections: 1,
    minLegProbability: 30,
    targetNetProfit: 20,
    targetProfitTolerance: 0,
  },
  {
    id: "tenfold-safe-3",
    title: "命中净利≥10倍 B · 单选3串1",
    rule: "基础投入2元 · 命中净利至少20元 · 3串1",
    markets: ["had", "hhad", "total", "halfFull"],
    matches: 3,
    selections: 1,
    minLegProbability: 30,
    targetNetProfit: 20,
    targetProfitTolerance: 0,
  },
  {
    id: "tenfold-safe-4",
    title: "命中净利≥10倍 C · 单选4串1",
    rule: "基础投入2元 · 命中净利至少20元 · 4串1",
    markets: ["had", "hhad", "total", "halfFull"],
    matches: 4,
    selections: 1,
    minLegProbability: 30,
    targetNetProfit: 20,
    targetProfitTolerance: 0,
  },
  {
    id: "half-full-double-3",
    title: "半全场双选3串1",
    rule: "每场覆盖2个走势 · 3串1",
    markets: ["halfFull"],
    matches: 3,
    selections: 2,
    requirePositiveMinProfit: true,
  },
  ...["A", "B", "C"].map((variant) => ({
    id: `twofold-${variant.toLowerCase()}`,
    title: `命中净利≥2倍 ${variant} · 单选2串1`,
    rule: "每场单选 · 2串1 · 最低净盈利≥投入2倍",
    markets: ["had", "hhad", "total", "halfFull"],
    matches: 2,
    selections: 1,
    minLegProbability: 30,
    minProfitMultiplier: 2,
    alternative: true,
  })),
  {
    id: "half-full-double-2",
    title: "半全场双选2串1",
    rule: "每场覆盖2个走势 · 2串1",
    markets: ["halfFull"],
    matches: 2,
    selections: 2,
    requirePositiveMinProfit: true,
  },
];
export const PURCHASE_PLAN_DAILY_TIME = "17:00";

// 赔率与概率均来自生成时的快照；预期返奖包含未命中的零返奖情形。
export function calculatePurchaseLegReturns(item) {
  const picks = Array.isArray(item?.picks) && item.picks.length ? item.picks : [item];
  if (
    !picks.length ||
    picks.some((pick) => !Number.isFinite(Number(pick?.odd)) || Number(pick.odd) <= 1)
  )
    return null;
  const economics=calculateTicketEconomics([{...item,picks}]);
  return {...economics,stake:economics.totalStake};
}

export const PURCHASE_PLAN_MODULES = [
  { id: "score", title: "比分方案", description: "比分单选、双选与不同串关" },
  { id: "total", title: "进球数方案", description: "总进球单选与双选组合" },
  { id: "result", title: "赛果方案", description: "胜平负与让球胜平负组合" },
  { id: "draw", title: "平局 / 让平", description: "专门跟踪平与让平组合" },
  { id: "halfFull", title: "半全场研究 / 历史", description: "近似分布尚待独立验证，新正式票暂停" },
  { id: "tenfold", title: "10倍收益约束", description: "同一模型的筛选预设，不是独立预测" },
  { id: "twofold", title: "2倍收益约束与备选", description: "按稳健性排序，不随机增加可信度" },
];
export const purchasePlanModuleId = (planId) => {
  const id = String(planId || "");
  if (id.startsWith("score-")) return "score";
  if (id.startsWith("total-")) return "total";
  if (id.startsWith("draw-or-handicap-draw-")) return "draw";
  if (id.startsWith("half-full-")) return "halfFull";
  if (id.startsWith("tenfold-")) return "tenfold";
  if (id.startsWith("twofold-")) return "twofold";
  return "result";
};

// The two total-goal strategies can select the exact same ticket. A saved batch
// is the deduplication boundary: identical picks in later batches are separate
// decisions and must remain in the historical record.
const totalGoalTicketKey = (plan) => {
  if (!plan?.items?.length || plan.status === "unavailable") return "";
  return JSON.stringify({
    passName: plan.passName,
    stake: plan.stake,
    items: plan.items
      .map((item) => ({
        match: `${item.officialMatchId || item.matchId}|${item.salesDate || item.matchDate || ""}`,
        market: item.market,
        picks: (item.picks?.length ? item.picks : [item])
          .map((pick) => [pick.pick, Number(pick.odd)])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      }))
      .sort((a, b) => a.match.localeCompare(b.match)),
  });
};

export const deduplicatePurchasePlans = (plans) => {
  if (!Array.isArray(plans)) return [];
  const canonical = plans.find(
    (plan) => plan.id === "total-double-2" && plan.status !== "unavailable",
  );
  const canonicalKey = totalGoalTicketKey(canonical);
  const distinctLegacy = plans.filter(
    (plan) =>
      plan.id === "total-adjacent-double-2" &&
      plan.status !== "unavailable" &&
      (!canonicalKey || totalGoalTicketKey(plan) !== canonicalKey),
  );
  return plans.flatMap((plan) => {
    if (plan.id === "total-adjacent-double-2") {
      if (!distinctLegacy.includes(plan)) return [];
      return [
        {
          ...plan,
          id: "total-double-2",
          title: "总进球双选2串1",
          rule: "每场2个进球数 · 2串1",
          originPlanId: "total-adjacent-double-2",
        },
      ];
    }
    if (plan.id === "total-double-2" && plan.status === "unavailable" && distinctLegacy.length)
      return [];
    return [plan];
  });
};

export const deduplicatePurchasePlanSets = (planSets) =>
  mergePurchaseBatches((planSets || []).map((set) => ({ ...set, plans: deduplicatePurchasePlans(set?.plans) }))).planSets;

const settledPlanStatuses = new Set([
  "won",
  "lost",
  "corrected_won",
  "corrected_lost",
  "void_won",
  "void_lost",
  "refunded",
]);
const wonPlanStatuses = new Set(["won", "corrected_won", "void_won"]);
export const summarizePurchasePlans = (plans) => {
  const resolved = (plans || []).filter((plan) => settledPlanStatuses.has(plan.status)),
    settled = resolved.filter(plan=>plan.status!=="refunded"),
    won = settled.filter((plan) => wonPlanStatuses.has(plan.status)).length;
  const stake = resolved.reduce((sum, plan) => sum + safeNumber(plan.stake), 0),
    returned = resolved.reduce((sum, plan) => sum + safeNumber(plan.simulatedReturn), 0);
  return {
    settled: settled.length,
    refunded:resolved.length-settled.length,
    won,
    rate: settled.length ? (won / settled.length) * 100 : 0,
    stake,
    returned,
    net: returned - stake,
  };
};
export const summarizePurchasePlanModules = (planSets) => {
  const plans = deduplicatePurchasePlanSets(planSets).flatMap((item) => item.plans);
  return Object.fromEntries(
    PURCHASE_PLAN_MODULES.map((module) => [
      module.id,
      summarizePurchasePlans(plans.filter((plan) => purchasePlanModuleId(plan.id) === module.id)),
    ]),
  );
};

// Keep missing capture days distinct from losing tickets. A date with no saved
// batch has no forecast to settle and must not enter the hit-rate denominator.
export const summarizePurchasePlanDays = (planSets) =>
  Object.fromEntries(
    Object.entries(
      deduplicatePurchasePlanSets(planSets).reduce((byDate, set) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(set?.date || ""))) return byDate;
        (byDate[set.date] ||= []).push(set);
        return byDate;
      }, {}),
    ).map(([date, batches]) => {
      const plans = batches.flatMap((batch) =>
        (batch.plans || []).filter((plan) => plan.status !== "unavailable" && plan.items?.length),
      );
      return [
        date,
        {
          date,
          batches: batches.length,
          tickets: plans.length,
          pending: plans.filter((plan) => !settledPlanStatuses.has(plan.status)).length,
          ...summarizePurchasePlans(plans),
        },
      ];
    }),
  );

// One row is one saved batch's ticket. Pending/invalid tickets stay visible in
// history but never enter the settled denominator or monetary totals.
export const summarizePurchasePlanDefinitions = (planSets) =>
  Object.fromEntries(
    PURCHASE_PLAN_DEFINITIONS.map((definition) => {
      const rows = deduplicatePurchasePlanSets(planSets)
        .flatMap((set) =>
          (set?.plans || [])
            .filter(
              (plan) =>
                plan.id === definition.id && plan.status !== "unavailable" && plan.items?.length,
            )
            .map((plan) => ({
              snapshotId: set.snapshotId || "",
              date: set.date,
              generatedAt: set.generatedAt,
              source: set.source || "",
              batchIdentity: purchaseBatchIdentity(set),
              scheduledTime: set.scheduledTime || null,
              decisionPolicy: set.decisionPolicy || null,
              baseModelVersion: set.baseModelVersion || null,
              calibrationVersion: set.calibrationVersion || null,
              riskPolicy: set.riskSelection?.policy || null,
              plan,
            })),
        )
        .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
      return [definition.id, { ...summarizePurchasePlans(rows.map((row) => row.plan)), samples: summarizePurchaseHistorySamples(rows), rows }];
    }),
  );

export const MARKET_META = {
  had: { name: "胜平负", code: "HAD", labels: ["胜", "平", "负"], maxPass: 8 },
  hhad: { name: "让球胜平负", code: "HHAD", labels: ["让胜", "让平", "让负"], maxPass: 8 },
  score: {
    name: "比分",
    code: "CRS",
    labels: [
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
    maxPass: 4,
  },
  total: {
    name: "总进球数",
    code: "TTG",
    labels: ["0球", "1球", "2球", "3球", "4球", "5球", "6球", "7+球"],
    maxPass: 6,
  },
  halfFull: {
    name: "半全场",
    code: "HAFU",
    labels: ["胜胜", "胜平", "胜负", "平胜", "平平", "平负", "负胜", "负平", "负负"],
    maxPass: 4,
  },
};
const safeNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const pointList = (points, labels) =>
  Array.isArray(points)
    ? points.map((point, index) =>
        typeof point === "object"
          ? {
              score: String(point.score || labels[index] || ""),
              probability: safeNumber(point.probability),
            }
          : { score: labels[index] || "", probability: safeNumber(point) },
      )
    : [];
const resultFromScore = (score) => {
  const [home, away] = String(score || "")
    .split(":")
    .map(Number);
  return !Number.isFinite(home) || !Number.isFinite(away)
    ? ""
    : home > away
      ? "胜"
      : home === away
        ? "平"
        : "负";
};
const zonedTime = (value) => {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return NaN;
  return Date.parse(text);
};
const freshnessLimit = (distance) =>
  distance <= 2 * 3600000
    ? 20 * 60000
    : distance <= 6 * 3600000
      ? 60 * 60000
      : distance <= 24 * 3600000
        ? 3 * 3600000
        : 6 * 3600000;

function matchMarkets(report, official, decisionAt) {
  const odds = official?.marketOdds || {},
    signal = report.marketSignal || {};
  const kickoff = zonedTime(official?.kickoffAt || report.kickoffAt),
    sourceAt = Date.parse(
      report.sourceFetchedAt || report.predictionGeneratedAt || report.generatedAt || "",
    );
  if (
    !Number.isFinite(kickoff) ||
    kickoff <= decisionAt ||
    !Number.isFinite(sourceAt) ||
    sourceAt > decisionAt + 5 * 60000 ||
    decisionAt - sourceAt > freshnessLimit(kickoff - decisionAt)
  )
    return [];
  const had = report.hadProbabilities?.length
    ? report.hadProbabilities
    : pointList(
        [report.probabilities?.home, report.probabilities?.draw, report.probabilities?.away],
        MARKET_META.had.labels,
      );
  const hhad = report.hhadProbabilities?.length
    ? report.hhadProbabilities
    : pointList(signal.modeledHhad, MARKET_META.hhad.labels);
  const fullScore=report.fullScoreDistribution;
  const grid=new Map((fullScore||[]).map(p=>[p.score,p.probability]));
  const scoreGridComplete=grid.size===169&&(fullScore||[]).length===169&&Array.from({length:169},(_,i)=>`${Math.floor(i/13)}:${i%13}`).every(label=>grid.has(label))&&(fullScore||[]).every(p=>typeof p.probability==="number"&&Number.isFinite(p.probability)&&p.probability>=0)&&Math.abs((fullScore||[]).reduce((sum,p)=>sum+p.probability,0)-100)<=.5;
  const score=scoreGridComplete?MARKET_META.score.labels.map(label=>({score:label,probability:(fullScore||[]).reduce((sum,p)=>{const [h,a]=p.score.split(":").map(Number),bucket=MARKET_META.score.labels.includes(p.score)?p.score:h>a?"胜其他":h===a?"平其他":"负其他";return sum+(bucket===label?p.probability:0);},0)})):[];
  const total = report.totalGoalProbabilities?.length
    ? report.totalGoalProbabilities
    : pointList(signal.modeledTotalGoals, MARKET_META.total.labels);
  const halfFull = report.halfFullProbabilities?.length
    ? report.halfFullProbabilities
    : pointList(signal.modeledHalfFull, MARKET_META.halfFull.labels);
  return [
    ["had", had, odds["胜平负"] || signal.officialOdds || official?.odds],
    ["hhad", hhad, odds["让球胜平负"] || signal.officialHhadOdds],
    ["score", score, odds["比分"]],
    ["total", total, odds["总进球数"]],
    ["halfFull", halfFull, odds["半全场"]],
  ].flatMap(([market, points, marketOdds]) => {
    const meta = MARKET_META[market],
      eligibility = official?.marketEligibility?.[meta.name],
      allowedPassCounts = Array.isArray(eligibility?.allowedPassCounts)
        ? eligibility.allowedPassCounts
            .map(Number)
            .filter((value) => Number.isInteger(value) && value >= 1 && value <= meta.maxPass)
        : [];
    if (
      eligibility?.qualification !== "qualified" ||
      String(eligibility?.salesStatus || "").toLowerCase() !== "selling" ||
      eligibility?.marketCode !== meta.code ||
      !allowedPassCounts.length
    )
      return [];
    if (
      market === "hhad" &&
      (!String(eligibility.handicap ?? "").trim() || !Array.isArray(points) || !points.length)
    )
      return [];
    const cutoff = eligibility.cutoffAt ? zonedTime(eligibility.cutoffAt) : kickoff;
    if (!Number.isFinite(cutoff) || cutoff <= decisionAt) return [];
    const byLabel = new Map(
      pointList(points, meta.labels).map((point) => [point.score, point.probability]),
    );
    if(byLabel.size!==meta.labels.length||!meta.labels.every(label=>byLabel.has(label))||[...byLabel.values()].some(p=>!Number.isFinite(p)||p<0||p>100)||Math.abs([...byLabel.values()].reduce((s,p)=>s+p,0)-100)>.5||!Array.isArray(points)||points.length!==meta.labels.length)return [];
    return meta.labels
      .map((pick, index) => ({
        pick,
        probability: safeNumber(byLabel.get(pick)),
        odd: safeNumber(marketOdds?.[index]),
      }))
      .filter((item) => item.probability > 0 && item.odd > 1)
      .sort((a, b) => b.probability - a.probability)
      .map((item) => ({
        matchId: String(report.id),
        officialMatchId: String(official.officialMatchId || official.matchId),
        salesDate: String(official.salesDate || report.salesDate || ""),
        matchDate: String(report.matchDate || official?.matchDate || report.time || ""),
        kickoffAt: String(official.kickoffAt),
        sourceFetchedAt: String(report.sourceFetchedAt || ""),
        matchStatus: String(official.matchStatus || report.matchStatus || ""),
        league: String(report.league || official?.league || ""),
        home: String(report.home),
        away: String(report.away),
        handicap:
          market === "hhad"
            ? String(eligibility.handicap)
            : String(report.handicap || signal.officialHandicap || official?.handicap || ""),
        market,
        marketCode: meta.code,
        marketName: meta.name,
        maxPass: meta.maxPass,
        allowedPassCounts,
        cutoffAt: eligibility.cutoffAt || official.kickoffAt,
        ruleVersion: eligibility.ruleVersion || "",
        ...item,
      }));
  });
}

function combinations(items, size) {
  const output = [];
  const walk = (start, picked) => {
    if (picked.length === size) {
      output.push([...picked]);
      return;
    }
    for (let index = start; index <= items.length - (size - picked.length); index++) {
      picked.push(items[index]);
      walk(index + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return output;
}
function goalNumber(pick) {
  const matched = String(pick || "").match(/^(\d+)(?:\+)?球$/);
  return matched ? Number(matched[1]) : NaN;
}
function legFrom(items, count, { adjacentPicks = false, minLegProbability = 0 } = {}) {
  const ranked = [...items].sort((a, b) => b.probability - a.probability);
  let selections = ranked.slice(0, count);
  if (adjacentPicks && count === 2) {
    const pairs = combinations(ranked, 2)
      .filter(
        (pair) =>
          pair.every((item) => Number.isFinite(goalNumber(item.pick))) &&
          Math.abs(goalNumber(pair[0].pick) - goalNumber(pair[1].pick)) === 1,
      )
      .sort(
        (left, right) =>
          right.reduce((sum, item) => sum + item.probability, 0) -
          left.reduce((sum, item) => sum + item.probability, 0),
      );
    selections = pairs[0] || [];
  }
  if (selections.length !== count) return null;
  const probability = selections.reduce((sum, item) => sum + item.probability, 0);
  if (probability < safeNumber(minLegProbability)) return null;
  const base = selections[0];
  return {
    ...base,
    picks: selections.map(({ pick, probability, odd }) => ({ pick, probability, odd })),
    pick: selections.map((item) => item.pick).join(" / "),
    probability,
    odd: 0,
  };
}
const ticketKey = (legs) =>
  legs
    .map(
      (leg) =>
        `${leg.officialMatchId}|${leg.salesDate}|${leg.market}|${leg.picks.map((pick) => pick.pick).join("/")}`,
    )
    .sort()
    .join(";");
function legVariants(items,count,options){
 const ranked=[...items].sort((a,b)=>b.probability*b.odd-a.probability*a.odd||b.probability-a.probability);
 const pool=[...new Map([...ranked.slice(0,6),...[...items].sort((a,b)=>b.probability-a.probability).slice(0,3)].map(p=>[p.pick,p])).values()].slice(0,8);
 const candidates=combinations(pool,count).map(p=>legFrom(p,count,options)).filter(Boolean);
 const roi=leg=>{const value=calculateTicketEconomics([leg]);return value.status==="ready"?value.expectedROI??-Infinity:-Infinity;};
 const choices=[...[...candidates].sort((a,b)=>roi(b)-roi(a)).slice(0,2),...[...candidates].sort((a,b)=>b.probability-a.probability).slice(0,1)];
 return [...new Map(choices.map(leg=>[leg.picks.map(p=>p.pick).sort().join("|"),leg])).values()];
}
function choosePlan(groups, definition, { excludedTickets = new Set(), rejections = {}, policy=DEFAULT_RECOMMENDATION_POLICY } = {}) {
  const allowedPicks = Array.isArray(definition.allowedPicks)
    ? new Set(definition.allowedPicks)
    : null;
  const variants = groups
    .map((group) =>
      definition.markets.filter(market=>!RESEARCH_MARKETS.has(market)).flatMap((market) => {
        const items = group.filter(
          (item) => item.market === market && (!allowedPicks || allowedPicks.has(item.pick)),
        );
        const legs = legVariants(items, definition.selections, {
          adjacentPicks: Boolean(definition.adjacentPicks),
          minLegProbability: definition.minLegProbability,
        });
        return legs;
      }),
    )
    .filter((group) => group.length)
    .sort((a,b)=>policy.selectionMode==="robust-ev"
      ? Math.max(...b.map(leg=>leg.picks.reduce((s,p)=>s+p.probability*p.odd/100,0)/leg.picks.length))-Math.max(...a.map(leg=>leg.picks.reduce((s,p)=>s+p.probability*p.odd/100,0)/leg.picks.length))
      : Math.max(...b.map(leg=>leg.probability))-Math.max(...a.map(leg=>leg.probability)))
    .slice(0,12);
  let evaluated=0;
  const viableCandidates = [];
  const rank=(a,b)=>policy.selectionMode==="robust-ev"
    ? b.expectedROI-a.expectedROI||b.expectedProfit-a.expectedProfit||b.probability-a.probability||ticketKey(a.items).localeCompare(ticketKey(b.items))
    : b.probability-a.probability||ticketKey(a.items).localeCompare(ticketKey(b.items));
  for (const fixtureSet of combinations(variants, definition.matches)) {
    if(evaluated>=6000){rejections.searchTruncated=true;break;}
    const walk = (index, legs) => {
      if(evaluated>=6000){rejections.searchTruncated=true;return;}
      if (index < fixtureSet.length) {
        for (const leg of fixtureSet[index]) walk(index + 1, [...legs, leg]);
        return;
      }
      if (!legs.every((leg) => leg.allowedPassCounts.includes(definition.matches))) return;
      if(new Set(legs.map(ticketFixtureKey)).size!==legs.length){rejections.input_invalid=(rejections.input_invalid||0)+1;return;}
      if (definition.mixed && new Set(legs.map((leg) => leg.market)).size < 2) return;
      const probability = legs.reduce((value, leg) => (value * leg.probability) / 100, 1),
        betCount = legs.reduce((value, leg) => value * leg.picks.length, 1),
        stake = betCount * 2;
      evaluated++;rejections.evaluated=(rejections.evaluated||0)+1;
      const economics=calculateTicketEconomics(legs);
      const candidate = {
        items: legs,
        probability,
        betCount,
        stake,
        ...economics,
      };
      if(economics.expectedProfit===null||economics.expectedProfit===undefined){rejections.missingProbability=(rejections.missingProbability||0)+1;return;}
      if(economics.expectedProfit<=1e-8){rejections.nonPositiveEV=(rejections.nonPositiveEV||0)+1;if(policy.selectionMode==="robust-ev")return;}
      else rejections.positiveEV=(rejections.positiveEV||0)+1;
      const assessment=assessRecommendation(legs,policy);
      if(!assessment.eligible){rejections[assessment.reason]=(rejections[assessment.reason]||0)+1;return;}
      if (candidate.minWinningProfit < 0) return;
      if (definition.requirePositiveMinProfit && candidate.minWinningProfit <= 0) return;
      if (candidate.minWinningProfit + 1e-9 < safeNumber(definition.minProfitMultiplier) * stake)
        return;
      if (definition.alternative) {
        candidate.ticketKey = ticketKey(legs);
        if (!excludedTickets.has(candidate.ticketKey)) viableCandidates.push(candidate);
        return;
      }
      const target = Number(definition.targetNetProfit),
        tolerance = Math.max(0, safeNumber(definition.targetProfitTolerance));
      if (Number.isFinite(target)) {
        if (candidate.minWinningProfit <= 0) return;
        if(candidate.minWinningProfit + tolerance < target){rejections.target_not_met=(rejections.target_not_met||0)+1;return;}
      }
      viableCandidates.push(candidate);
    };
    walk(0, []);
  }
  viableCandidates.sort(rank);
  // Retain different fixture sets as well as different picks, so risk rejection
  // can fall back to a genuinely less concentrated ticket, not just another label.
  const seenTickets=new Set(),seenFixtures=new Set(),shortlist=[];
  const add=candidate=>{const key=ticketKey(candidate.items);if(!seenTickets.has(key)){seenTickets.add(key);shortlist.push(candidate);}};
  for(const candidate of viableCandidates){const fixtures=candidate.items.map(ticketFixtureKey).sort().join(";");if(!seenFixtures.has(fixtures)){seenFixtures.add(fixtures);add(candidate);}if(shortlist.length>=6)break;}
  for(const candidate of viableCandidates){if(shortlist.length>=8)break;add(candidate);}
  shortlist.sort(rank);
  return shortlist.length?{...shortlist[0],alternatives:shortlist.slice(1)}:null;
}

const dateOnly = (value) => String(value || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
const officialKey = (match) =>
  `${String(match?.officialMatchId || match?.matchId || "")}|${dateOnly(match?.salesDate || match?.matchDate || match?.kickoffAt)}`;

export function generatePurchasePlans({
  date,
  reports,
  officialMatches,
  generatedAt = new Date().toISOString(),
  riskPolicy = DEFAULT_RECOMMENDATION_POLICY,
  priorPlans = /** @type {Array<object>} */ ([]),
}) {
  riskPolicy = normalizeRecommendationPolicy(riskPolicy);
  const decisionAt = Date.parse(generatedAt);
  if (!Number.isFinite(decisionAt)) throw new Error("方案生成时间无效，拒绝生成可售组合");
  const officialByKey = new Map(
    (officialMatches || [])
      .filter((match) => match?.officialMatchId || match?.matchId)
      .map((match) => [officialKey(match), match]),
  );
  const reportCounts=new Map();for(const report of reports||[])reportCounts.set(officialKey(report),(reportCounts.get(officialKey(report))||0)+1);
  const pairs = (reports || [])
    .map((report) => ({ report, official: officialByKey.get(officialKey(report)) }))
    .filter(
      (pair) =>
        pair.official &&
        reportCounts.get(officialKey(pair.report))===1 &&
        pair.report?.officialMappingStatus === "verified" &&
        !pair.report.isMock &&
        String(pair.official.matchStatus || "").toLowerCase() === "selling",
    );
  const groups = pairs
    .map(({ report, official }) => matchMarkets(report, official, decisionAt))
    .filter((group) => group.length);
  const evaluatedFixtures=new Set(groups.map(group=>`${group[0].officialMatchId}|${group[0].salesDate}`));
  const fixtureDecisions=(officialMatches||[]).map(match=>{
    const key=officialKey(match),kickoff=zonedTime(match.kickoffAt);
    const expectedMarkets=Object.entries(MARKET_META).filter(([market,meta])=>{const m=match.marketEligibility?.[meta.name];return !RESEARCH_MARKETS.has(market)&&m?.qualification==="qualified"&&String(m.salesStatus).toLowerCase()==="selling"&&m.marketCode===meta.code&&m.allowedPassCounts?.some(n=>n>=2)&&Date.parse(m.cutoffAt||match.kickoffAt)>decisionAt;}).map(([market])=>market);
    const expected=String(match.matchStatus||"").toLowerCase()==="selling"&&Number.isFinite(kickoff)&&kickoff>decisionAt&&expectedMarkets.length>0;
    const evaluatedMarkets=[...new Set(groups.find(group=>`${group[0].officialMatchId}|${group[0].salesDate}`===key)?.map(p=>p.market)||[])];
    const missingMarkets=expected?expectedMarkets.filter(m=>!evaluatedMarkets.includes(m)):[];
    const evaluated=evaluatedFixtures.has(key)&&missingMarkets.length===0;
    return {officialMatchId:String(match.officialMatchId||match.matchId||""),salesDate:match.salesDate,kickoffAt:match.kickoffAt,expected,evaluated,
      expectedMarkets,evaluatedMarkets,missingMarkets,reason:evaluated?"evaluated":!expected?"not-currently-eligible":reportCounts.get(key)>1?"duplicate-prediction":!reportCounts.has(key)?"missing-prediction":"prediction-or-market-validation-failed"};
  });
  const coverage={expectedEligibleCount:fixtureDecisions.filter(r=>r.expected).length,evaluatedFixtureCount:fixtureDecisions.filter(r=>r.evaluated).length,missingEligibleCount:fixtureDecisions.filter(r=>r.expected&&!r.evaluated).length,fixtures:fixtureDecisions};
  const plans = [];
  const rejectionCounts={},perDefinition={};
  const selectedTwofoldTickets = new Set();
  for (const definition of PURCHASE_PLAN_DEFINITIONS) {
    const localRejections={};perDefinition[definition.id]=localRejections;
    const found = choosePlan(groups, definition, {
      excludedTickets: selectedTwofoldTickets,
      rejections:localRejections,
      policy:riskPolicy,
    });
    if (!found) {
      plans.push({
        id: definition.id,
        title: definition.title,
        rule: definition.rule,
        status: "unavailable",
        reasonCode:definition.markets.every(m=>RESEARCH_MARKETS.has(m))?"research_only":localRejections.evaluated>0?"no-robust-plan":"insufficient-data",
        reason: definition.markets.every(m=>RESEARCH_MARKETS.has(m))?"半全场采用简化时间分配模型，尚未独立验证；保留研究和历史结算，暂停新正式票。":localRejections.evaluated>0?(riskPolicy.selectionMode==="robust-ev"?"候选未同时满足模型收益余量、概率下调压力测试及返奖约束，本类型不投注。":"候选未满足整票命中返奖约束，本类型不投注（期望收益仅作提示）。"):"合规玩法、预测、场次数或官方赔率不足；无法评估本类型，不补造方案。",
        items: [],
        combinedOdd: 0,
        estimatedProbability: 0,
        betCount: 0,
        stake: 0,
        minWinningReturn: 0,
        maxWinningReturn: 0,
        theoreticalReturn: 0,
      });
      continue;
    }
    if (definition.alternative) selectedTwofoldTickets.add(found.ticketKey);
    const makePlan=found=>({
      id: definition.id,
      title: definition.title,
      rule: definition.rule,
      status: "pending",
      items: found.items,
      passName: `${definition.matches}串1`,
      combinedOdd: 0,
      estimatedProbability: found.probability,
      betCount: found.betCount,
      stake: found.stake,
      minWinningReturn: found.minWinningReturn,
      maxWinningReturn: found.maxWinningReturn,
      decision: {
        objective: riskPolicy.selectionMode!=="robust-ev"
          ? "整票命中返奖约束内优先命中概率（有界搜索）；期望收益与压力结果仅作风险提示"
          : definition.alternative
          ? "同一模型稳健候选的确定性备选（有界搜索）"
          : Number.isFinite(definition.targetNetProfit)
            ? "目标命中盈利为筛选门槛，稳健正EV后按ROI排序"
            : "合规约束内正模型EV，按ROI/期望利润排序（有界搜索）",
        targetNetProfit: Number.isFinite(definition.targetNetProfit)
          ? definition.targetNetProfit
          : null,
        targetProfitTolerance: Number.isFinite(definition.targetNetProfit)
          ? definition.targetProfitTolerance
          : null,
        targetMet: Number.isFinite(definition.targetNetProfit)
          ? found.minWinningProfit + safeNumber(definition.targetProfitTolerance) >= definition.targetNetProfit
          : null,
        minWinningProfitConstraint: safeNumber(definition.minProfitMultiplier) * found.stake,
        maximumLoss: found.stake,
        probabilityAssumption: "independent-matches",
        expectedProfitGuaranteed: false,
      },
      minWinningProfit: found.minWinningProfit,
      maxWinningProfit: found.maxWinningProfit,
      expectedReturn:found.expectedReturn,expectedProfit:found.expectedProfit,expectedROI:found.expectedROI,
      sensitivity:ticketSensitivity(found.items),
      theoreticalReturn: found.maxWinningReturn,
    });
    plans.push({...makePlan(found),candidateAlternatives:found.alternatives.map(makePlan)});
  }
  const selection=selectRecommendationPortfolio(deduplicatePurchasePlans(plans),{policy:riskPolicy,priorPlans});
  const {portfolio:selectionPortfolio,...riskSelectionWithPlans}=selection;
  const riskSelection={...riskSelectionWithPlans,plans:undefined};
  const finalPlans=selection.plans;for(const counts of Object.values(perDefinition))for(const [key,value] of Object.entries(counts))rejectionCounts[key]=key==="searchTruncated"?Boolean(rejectionCounts[key]||value):(rejectionCounts[key]||0)+value;
  // Shared fixtures use one assessment distribution; frozen ticket prices stay unchanged.
  const predictionIds=[...new Set(pairs.map(({report})=>report.predictionId).filter(Boolean))];
  const scenarioInput={plans:finalPlans,fixtureForecasts:pairs.map(({report})=>({officialMatchId:report.officialMatchId,salesDate:report.salesDate,kickoffAt:report.kickoffAt,predictionId:report.predictionId,predictionGeneratedAt:report.predictionGeneratedAt,fullScoreDistribution:report.fullScoreDistribution})),basisPredictionId:predictionIds.length===1?predictionIds[0]:"",assessmentAt:generatedAt,currentBatchId:`${date}|${generatedAt}`};
  const portfolioScenarios={current:calculatePortfolioScenarioRisk(scenarioInput),day:priorPlans.length?calculatePortfolioScenarioRisk({...scenarioInput,priorPlans}):null};
  return {
    portfolioScenarios,
    riskSelection,decisionPolicy:riskPolicy.selectionMode==="robust-ev"?"robust-ev-diversified-portfolio-v3":PURCHASE_DECISION_POLICY,decisionSummary:{coverage,evaluated:(Boolean(rejectionCounts.evaluated)||coverage.expectedEligibleCount===0)&&coverage.missingEligibleCount===0&&selection.priorState!=="invalid",noBet:(rejectionCounts.evaluated>0||coverage.expectedEligibleCount===0)&&coverage.missingEligibleCount===0&&selection.priorState!=="invalid"&&!finalPlans.some(p=>p.status==="pending"),modelEligibleCount:selection.modelEligibleCount,selectionStatus:selection.priorState==="invalid"?"data-risk-invalid":coverage.missingEligibleCount&&!selection.selected?"incomplete-evaluation":selection.selected?"selected":selection.modelEligibleCount?"risk-constrained":"no-qualified-candidates",rejectionCounts,perDefinition,searchScope:"bounded-official-market-candidates-not-global-optimum"},portfolio:selectionPortfolio,
    version: PURCHASE_PLAN_VERSION,
    date,
    generatedAt,
    baseModelVersion:[...new Set((reports||[]).map(r=>r.baseModelVersion).filter(Boolean))].length===1?(reports||[]).find(r=>r.baseModelVersion)?.baseModelVersion:null,
    calibrationVersion:[...new Set((reports||[]).map(r=>r.calibrationVersion).filter(Boolean))].length===1?(reports||[]).find(r=>r.calibrationVersion)?.calibrationVersion:null,
    scheduledTime: PURCHASE_PLAN_DAILY_TIME,
    source: "每日17:00预测版本 + 中国体育彩票生成时固定奖金",
    plans: finalPlans,
  };
}

// Recheck frozen selections at the actual completion time, not the start time.
export function verifyPurchasePlanCompletion(planSet,officialMatches,completedAt){
  const at=Date.parse(completedAt),officials=new Map((officialMatches||[]).map(m=>[officialKey(m),m]));
  if(!Number.isFinite(at))throw new Error("实际完成时间无效");
  for(const plan of planSet.plans||[])for(const leg of plan.status==="unavailable"?[]:plan.items||[]){
    const match=officials.get(officialKey(leg)),meta=MARKET_META[leg.market],eligibility=match?.marketEligibility?.[meta?.name];
    if(!match||match.isMock||String(match.matchStatus||"").toLowerCase()!=="selling"||!meta||RESEARCH_MARKETS.has(leg.market)||eligibility?.qualification!=="qualified"||String(eligibility.salesStatus).toLowerCase()!=="selling"||!eligibility.allowedPassCounts?.includes(plan.items.length))throw new Error("实际完成时官方销售资格无法核验");
    if(!(Date.parse(match.kickoffAt)>at)||!(Date.parse(eligibility.cutoffAt||match.kickoffAt)>at))throw new Error("计算完成时比赛已开赛或停售，未保存正式票");
    for(const pick of leg.picks||[leg]){const index=meta.labels.indexOf(pick.pick);if(index<0||Number(match.marketOdds?.[meta.name]?.[index])!==pick.odd)throw new Error("冻结投注选项与官方赔率不一致");}
  }
  return true;
}

export function settlePurchasePlan(plan, results, { now = Date.now() } = {}) {
  if (plan.status === "unavailable") return plan;
  const lookup = new Map();
  for (const result of results || []) {
    const date = dateOnly(result.date || result.matchDate);
    if ((result.officialMatchId || result.matchId) && date)
      lookup.set(`official:${String(result.officialMatchId || result.matchId)}|${date}`, result);
    if (result.id && date) lookup.set(`display:${String(result.id)}|${date}`, result);
  }
  let unresolved = false,
    hasVoid = false,
    hasSettledVoid = false,
    hasCorrection = false;
  const items = plan.items.map((item) => {
    const date = dateOnly(item.matchDate || item.salesDate || item.kickoffAt),
      result =
        lookup.get(`official:${item.officialMatchId}|${date}`) ||
        lookup.get(`display:${item.matchId}|${date}`);
    if (!result) {
      unresolved = true;
      const kickoff = zonedTime(item.kickoffAt),
        finished =
          /finish|complete|ended/.test(String(item.matchStatus || "").toLowerCase()) ||
          (Number.isFinite(kickoff) && now >= kickoff + 3 * 3600000);
      return {
        ...item,
        settlementState: finished ? "awaiting_official_result" : "waiting_match",
        actual: finished ? "等待官方结果" : "待赛",
        result: finished ? "已完赛待官方结果" : "待赛",
      };
    }
    const status = String(result.status || "").toLowerCase();
    if (/cancel|void|invalid|abandon/.test(status)) {
      if (result.voidRule === "odds_one") {
        hasSettledVoid = true;
        return {
          ...item,
          settlementState: "void_settled",
          settlementOdd: 1,
          actual: "无效（按1.00结算）",
          result: "无效结算",
        };
      }
      hasVoid = true;
      return { ...item, settlementState: "void", actual: "无效", result: "等待规则确认" };
    }
    if (/postpon/.test(status)) {
      unresolved = true;
      return { ...item, settlementState: "postponed", actual: "延期", result: "延期" };
    }
    const hhadActual = result.hhadResult
        ? `让${String(result.hhadResult).match(/[胜平负](?!.*[胜平负])/)?.[0] || ""}`
        : "",
      totalRaw = String(result.totalGoalsResult || "").replace(/\s/g, "");
    const totalMarketParts = /^(\d{1,2})\+?球?$/.exec(totalRaw);
    const totalFromMarket = totalMarketParts
      ? Number(totalMarketParts[1]) >= 7
        ? "7+球"
        : `${Number(totalMarketParts[1])}球`
      : "";
    const scoreParts = /^(\d{1,2}):(\d{1,2})$/.exec(String(result.fullScore || "").trim());
    const finalScore = scoreParts ? scoreParts[0] : "";
    const goalCount = scoreParts ? Number(scoreParts[1]) + Number(scoreParts[2]) : null;
    const totalFromScore = scoreParts ? (goalCount >= 7 ? "7+球" : `${goalCount}球`) : "";
    const actual =
      item.market === "had"
        ? result.hadResult || resultFromScore(result.fullScore)
        : item.market === "hhad"
          ? hhadActual
          : item.market === "score"
            ? result.scoreResult || result.fullScore
            : item.market === "total"
              ? totalFromMarket || totalFromScore
              : result.halfScore && result.fullScore
                ? `${resultFromScore(result.halfScore)}${resultFromScore(result.fullScore)}`
                : "";
    if (!actual) {
      unresolved = true;
      return {
        ...item,
        settlementState: "field_pending",
        finalScore,
        actual: "字段待补",
        result: "字段待补",
      };
    }
    const corrected = /correct|revise|订正/.test(status);
    if (corrected) hasCorrection = true;
    const picks =
      Array.isArray(item.picks) && item.picks.length
        ? item.picks.map((selection) => selection.pick)
        : [item.pick];
    return {
      ...item,
      finalScore,
      actual,
      result: picks.includes(actual) ? "命中" : "未中",
      settlementState: corrected ? "corrected" : "settled",
    };
  });
  const resolved = items.filter((item) =>
      ["settled", "corrected", "void_settled"].includes(item.settlementState),
    ),
    won =
      !unresolved &&
      !hasVoid &&
      resolved.length === items.length &&
      items.every((item) => item.result === "命中" || item.settlementState === "void_settled");
  const status = hasVoid
    ? "void"
    : unresolved
      ? items.some((item) => item.settlementState === "field_pending")
        ? "field_pending"
        : items.some((item) => item.settlementState === "postponed")
          ? "postponed"
          : items.some((item) => item.settlementState === "awaiting_official_result")
            ? "awaiting_result"
            : "pending"
      : hasCorrection
        ? won
          ? "corrected_won"
          : "corrected_lost"
        : hasSettledVoid
          ? won
            ? "void_won"
            : "void_lost"
          : won
            ? "won"
            : "lost";
  if (unresolved || hasVoid) return {...plan,items,status,simulatedReturn:0};
  try {
    const cash=settleTicket(items);
    const resolvedStatus=cash.status==="pending"?"field_pending":cash.status==="refund"?"refunded":`${hasCorrection?"corrected_":hasSettledVoid?"void_":""}${cash.status}`;
    return {...plan,items,status:resolvedStatus,simulatedReturn:cash.returned??0,settlementVersion:cash.version};
  } catch {return {...plan,items,status:"field_pending",simulatedReturn:0};}
}
