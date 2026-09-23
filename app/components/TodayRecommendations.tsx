/* eslint-disable react-hooks/set-state-in-effect */
"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {readBrowserData,writeBrowserData} from "../browser-storage";
import {
  calculateRecommendationReturns, priceRecommendationSelections,
  type OfficialRecommendationMatch, type PricedSelection, type RecommendationMarket,
} from "../recommendation-returns";
import {
  MAX_COMBINATION_CANDIDATES,
  MIN_COMPLETENESS,
  parseZonedKickoff,
  PREDICTION_STORAGE_KEY,
  refreshPolicy,
  SavedPrediction,
  SavedPredictionSet,
  ScorePoint,
} from "../prediction-config";
import {
  generatePurchasePlans,
  PURCHASE_PLAN_DEFINITIONS,
  PURCHASE_PLAN_MODULES,
  PURCHASE_PLAN_STORAGE_KEY,
  purchasePlanModuleId,
  settlePurchasePlan,
  summarizePurchasePlanModules,
  summarizePurchasePlans,
} from "../purchase-plan-engine";

type Model = "odds" | "intelligence" | "consensus";
type Candidate = {
  match: SavedPrediction;
  market: RecommendationMarket;
  scores: PricedSelection[];
  coverage: number;
  confidence: number;
  completeness: number;
  singleModel: boolean;
};
type Combination = {
  items: Candidate[];
  probability: number;
  averageCompleteness: number;
  returns: ReturnType<typeof calculateRecommendationReturns>;
  oddsFetchedAt: string;
};
const modelNames: Record<Model, string> = {
  odds: "赔率模型",
  intelligence: "综合情报模型",
  consensus: "双模型共识",
};
const marketNames: Record<RecommendationMarket, string> = {
  score: "比分",
  had: "胜平负",
  hhad: "让球胜平负",
  total: "总进球数",
  halfFull: "半全场",
};
const marketEligibilityNames: Record<RecommendationMarket, string> = {
  score: "比分",
  had: "胜平负",
  hhad: "让球胜平负",
  total: "总进球数",
  halfFull: "半全场",
};
const marketMaxPass: Record<RecommendationMarket, number> = {
  score: 4,
  had: 8,
  hhad: 8,
  total: 6,
  halfFull: 4,
};
const selectionUnit = (market: RecommendationMarket) =>
  market === "score" ? "比分" : market === "total" ? "进球数" : "结果";
const passNames = (n: number) => (n === 1 ? "单场" : `${n}串1`);

function mergeScores(
  match: SavedPrediction,
): { scores: ScorePoint[]; singleModel: boolean } | null {
  const scores = match.fullScoreDistribution?.length
    ? match.fullScoreDistribution
    : match.combinedScores;
  return scores?.length
    ? { scores, singleModel: Boolean(match.singleModel) }
    : null;
}
function combinations<T>(items: T[], size: number) {
  const result: T[][] = [];
  const walk = (start: number, picked: T[]) => {
    if (picked.length === size) {
      result.push([...picked]);
      return;
    }
    for (
      let index = start;
      index <= items.length - (size - picked.length);
      index++
    ) {
      picked.push(items[index]);
      walk(index + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return result;
}
function confidenceLabel(value: number) {
  return value >= 82
    ? "高"
    : value >= 68
      ? "中高"
      : value >= 52
        ? "中等"
        : "偏低";
}

type PurchaseItem = {
  matchId: string;
  officialMatchId?: string;
  salesDate?: string;
  matchDate?: string;
  kickoffAt?: string;
  league: string;
  home: string;
  away: string;
  market: string;
  marketName: string;
  pick: string;
  probability: number;
  odd: number;
  picks?: { pick: string; probability: number; odd: number }[];
  result?: string;
  actual?: string;
  settlementState?: string;
};
type PurchasePlan = {
  id: string;
  title: string;
  rule: string;
  status: string;
  reason?: string;
  passName?: string;
  items: PurchaseItem[];
  combinedOdd: number;
  estimatedProbability: number;
  stake: number;
  theoreticalReturn: number;
  betCount?: number;
  minWinningReturn?: number;
  maxWinningReturn?: number;
  minWinningProfit?: number;
  maxWinningProfit?: number;
  simulatedReturn?: number;
};
type PurchasePlanSet = {
  version?: number;
  date: string;
  generatedAt: string;
  source: string;
  plans: PurchasePlan[];
  snapshotId?: string;
  contentHash?: string;
  scheduledTime?: string;
};
const currentPurchasePlanIds=new Set(PURCHASE_PLAN_DEFINITIONS.map(definition=>definition.id));
const hasPurchasePlanData=(item:PurchasePlanSet|undefined|null)=>Boolean(item?.plans?.some(plan=>currentPurchasePlanIds.has(plan.id)&&plan.status!=="unavailable"&&Array.isArray(plan.items)&&plan.items.length>0));
type OfficialMatch = OfficialRecommendationMatch;
const shanghaiDate = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const dateOnly = (value?: string) =>
  String(value || "").match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
const officialKey = (match: OfficialMatch | SavedPrediction) =>
  `${String(match.officialMatchId || ("matchId" in match ? match.matchId : "") || "")}|${dateOnly(match.salesDate || match.matchDate || match.kickoffAt)}`;
const matchDateKey = (match: SavedPrediction, current?: OfficialMatch) =>
  dateOnly(
    current?.salesDate ||
      match.salesDate ||
      current?.matchDate ||
      current?.kickoffAt ||
      match.matchDate ||
      match.kickoffAt ||
      match.time ||
      match.salesDate,
  );
const formatMatchDay = (value: string) => {
  const [, month, day] = value.match(/^\d{4}-(\d{2})-(\d{2})$/) || [];
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  })
    .format(new Date(`${value}T12:00:00+08:00`))
    .replace("星期", "周");
  return month && day ? `${weekday}场次（${month}月${day}日）` : value;
};

type OfficialSnapshot = { matches: OfficialMatch[]; fetchedAt: string; error: string };
let officialSnapshot: OfficialSnapshot = {
    matches: [],
    fetchedAt: "",
    error: "",
  },
  officialTimer: ReturnType<typeof setTimeout> | undefined,
  officialRequest: Promise<OfficialSnapshot | null> | undefined;
const officialListeners = new Set<
  (snapshot: typeof officialSnapshot) => void
>();
function refreshOfficialMarkets(): Promise<OfficialSnapshot | null> {
  if (officialRequest) return officialRequest;
  officialRequest = (async () => {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch("/api/sporttery", { cache: "no-store", signal: controller.signal }),
      payload = await response.json();
      if (!response.ok || !Array.isArray(payload.matches)) throw new Error(payload.error || "体彩赔率读取失败");
      officialSnapshot = {
        matches: payload.matches,
        fetchedAt: payload.fetchedAt || new Date().toISOString(),
        error: "",
      };
      officialListeners.forEach((listener) => listener(officialSnapshot));
      return officialSnapshot;
    } catch (error) {
      officialSnapshot = {...officialSnapshot, error: error instanceof Error ? error.message : "体彩赔率读取失败"};
      officialListeners.forEach(listener => listener(officialSnapshot));
      return null;
    } finally {
      clearTimeout(timeout);
      officialRequest = undefined;
      const future = officialSnapshot.matches
        .map((match) => parseZonedKickoff(match.kickoffAt))
        .filter((value) => Number.isFinite(value) && value > Date.now()),
      nearest = future.length ? Math.min(...future) : NaN,
      policy = refreshPolicy(
        Number.isFinite(nearest) ? new Date(nearest).toISOString() : null,
      );
    if (officialTimer) clearTimeout(officialTimer);
      officialTimer = officialListeners.size ? setTimeout(() => void refreshOfficialMarkets(), policy.refreshMs) : undefined;
    }
  })();
  return officialRequest;
}
function useOfficialMarkets(data: SavedPredictionSet | null) {
  const [snapshot, setSnapshot] = useState(officialSnapshot);
  useEffect(() => {
    if (!data) return;
    officialListeners.add(setSnapshot);
    if (!officialSnapshot.fetchedAt || !officialTimer) refreshOfficialMarkets();
    return () => {
      officialListeners.delete(setSnapshot);
      if (!officialListeners.size && officialTimer) {
        clearTimeout(officialTimer);
        officialTimer = undefined;
      }
    };
  }, [data]);
  return snapshot;
}

function DailyPurchasePlans({
  data,
  officialMatches: provided,
  lotteryDate,
}: {
  data: SavedPredictionSet | null;
  officialMatches?: OfficialMatch[];
  lotteryDate?: string;
}) {
  const liveOfficial = useOfficialMarkets(data),
    officialMatches = provided || liveOfficial.matches,
    scopedOfficialMatches = useMemo(()=>lotteryDate
      ? officialMatches.filter(
          (match) =>
            dateOnly(match.salesDate || match.matchDate || match.kickoffAt) ===
            lotteryDate,
        )
      : officialMatches,[officialMatches,lotteryDate]),
    scopedReports = useMemo(()=>lotteryDate
      ? (data?.matches || []).filter(
          (match) => matchDateKey(match) === lotteryDate,
        )
      : data?.matches || [],[data,lotteryDate]);
  const [planSet, setPlanSet] = useState<PurchasePlanSet | null>(null),
    [planSets, setPlanSets] = useState<PurchasePlanSet[]>([]),
    [status, setStatus] = useState("正在读取方案快照…"),
    [busy, setBusy] = useState(false);
  async function selectPlanSet(selected: PurchasePlanSet) {
    setBusy(true);
    const resultDates = Array.from(
      new Set(
        selected.plans.flatMap((plan) =>
          plan.items.map(
            (item) =>
              item.matchDate?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || selected.date,
          ),
        ),
      ),
    );
    const resultPayloads = await Promise.all(
      resultDates.map((date) =>
        fetch(`/api/sporttery/results?date=${date}`, { cache: "no-store" })
          .then((response) => response.json())
          .catch(() => ({ results: [] })),
      ),
    );
    const results = resultPayloads.flatMap((payload) =>
      Array.isArray(payload.results) ? payload.results : [],
    );
    setPlanSet({
      ...selected,
      plans: selected.plans.map((plan) => settlePurchasePlan(plan, results)),
    });
    setStatus(
      `${selected.date === shanghaiDate() ? "今日" : "历史"}方案 · ${new Date(selected.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}批次`,
    );
    setBusy(false);
  }
  useEffect(() => {
    let active = true;
    setBusy(true);
    fetch("/api/prediction-snapshots?view=recommendations", { cache: "no-store" })
      .then((response) => response.json())
      .catch(() => ({ snapshots: [] }))
      .then(async (archive) => {
        if (!active) return;
        const matches = scopedOfficialMatches;
        let locals: PurchasePlanSet[] = [];
        try {
          const stored=await readBrowserData<PurchasePlanSet[]>(PURCHASE_PLAN_STORAGE_KEY,[]);
          locals=Array.isArray(stored)?stored:[];
        } catch {
          /* 损坏缓存不参与推荐 */
        }
        const periodicSets: PurchasePlanSet[] = (
          Array.isArray(archive.purchasePlanSnapshots)
            ? archive.purchasePlanSnapshots
            : []
        )
          .map((snapshot: { planSet?: PurchasePlanSet }) => snapshot.planSet)
          .filter(
            (item: PurchasePlanSet | undefined): item is PurchasePlanSet =>
              hasPurchasePlanData(item),
          );
        const legacySets: PurchasePlanSet[] = (
          Array.isArray(archive.snapshots) ? archive.snapshots : []
        )
          .map(
            (snapshot: { purchasePlans?: PurchasePlanSet }) =>
              snapshot.purchasePlans,
          )
          .filter(
            (item: PurchasePlanSet | undefined): item is PurchasePlanSet =>
              hasPurchasePlanData(item),
          );
        const allSets = Array.from(
          new Map(
            [...periodicSets, ...legacySets, ...locals]
              .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
              .map((item) => [
                item.snapshotId ||
                  `${item.generatedAt}-${item.contentHash || "legacy"}`,
                item,
              ]),
          ).values(),
        ).filter(hasPurchasePlanData).filter((item) => {
          if (!lotteryDate) return true;
          const itemDates = item.plans.flatMap((plan) =>
            plan.items.map(
              (entry) =>
                dateOnly(
                  entry.salesDate || entry.matchDate || entry.kickoffAt,
                ) || item.date,
            ),
          );
          return itemDates.length > 0 && itemDates.every((date) => date === lotteryDate);
        });
        const historyDates=Array.from(new Set(allSets.flatMap(item=>item.plans.flatMap(plan=>plan.items.map(entry=>dateOnly(entry.matchDate||entry.salesDate||entry.kickoffAt)||item.date))))).filter(Boolean);
        const historyPayloads=await Promise.all(historyDates.map(date=>fetch(`/api/sporttery/results?date=${date}`,{cache:"no-store"}).then(response=>response.json()).catch(()=>({results:[]}))));
        const historyResults=historyPayloads.flatMap(payload=>Array.isArray(payload.results)?payload.results:[]);
        const settledSets=allSets.map(item=>({...item,plans:item.plans.map(plan=>settlePurchasePlan(plan,historyResults))}));
        if (active) {
          setPlanSets(settledSets);
          setPlanSet(null);
        }
        let selected = settledSets[0] || null;
        // 已归档方案必须按生成时赔率原样读取；规则升级或当前赔率变化都不能回写历史方案。
        if (!selected && data?.date === shanghaiDate() && matches.length) {
          selected = generatePurchasePlans({
            date: lotteryDate || data.date,
            reports: scopedReports,
            officialMatches: matches,
          }) as PurchasePlanSet;
          if(hasPurchasePlanData(selected))await writeBrowserData(PURCHASE_PLAN_STORAGE_KEY,[selected,...locals.filter(hasPurchasePlanData)].slice(0,30));
          else selected=null;
        }
        if (selected && active) await selectPlanSet(selected);
        else if (active) setStatus("该日期没有可用组合票，已从批次选项中移除");
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [data, lotteryDate, scopedOfficialMatches, scopedReports]);
  function preview() {
    if (!data || !officialMatches.length) return;
    setBusy(true);
    const generated = generatePurchasePlans({
      date: lotteryDate || data.date,
      reports: scopedReports,
      officialMatches: scopedOfficialMatches,
    }) as PurchasePlanSet;
    setPlanSet({
      ...generated,
      source: "按当前盘口手动试算（非17:00定时快照）",
    });
    setStatus("当前盘口试算");
    setBusy(false);
  }
  const planResult = (plan: PurchasePlan) =>
    ["won", "corrected_won", "void_won"].includes(plan.status)
      ? `模拟返还 ¥${(plan.simulatedReturn || 0).toFixed(2)}`
      : ["lost", "corrected_lost", "void_lost"].includes(plan.status)
        ? "模拟未中"
        : plan.status === "void"
          ? "无效待规则确认"
          : plan.status === "postponed"
            ? "延期"
            : plan.status === "field_pending"
              ? "字段待补"
              : plan.status === "awaiting_result"
                ? "已完赛待官方结果"
                : "待赛";
  const planStats=useMemo(()=>summarizePurchasePlans(planSets.flatMap(item=>item.plans)),[planSets]);
  const moduleStats=useMemo(()=>summarizePurchasePlanModules(planSets),[planSets]);
  const visiblePlanModules=useMemo(()=>PURCHASE_PLAN_MODULES.map(module=>({
    ...module,
    definitions:PURCHASE_PLAN_DEFINITIONS.filter(definition=>purchasePlanModuleId(definition.id)===module.id&&planSet?.plans.some(plan=>plan.id===definition.id&&plan.status!=="unavailable"&&plan.items.length>0)),
  })).filter(module=>module.definitions.length>0),[planSet]);
  return (
    <section className="daily-purchase-panel">
      <header>
        <div>
          <small>DAILY PURCHASE DRAFT</small>
          <h3>每日固定组合票</h3>
          <p>
            每天北京时间17:00生成并留档；按每注2元计算实际组合投入，次日依据官方赛果自动标记。
          </p>
        </div>
        <div>
          <span>{status}</span>
          {planSets.length > 1 && (
            <select
              aria-label="选择预购买方案快照"
              value={planSet?.snapshotId || planSet?.generatedAt || ""}
              disabled={busy}
              onChange={(event) => {
                const selected = planSets.find(
                  (item) =>
                    (item.snapshotId || item.generatedAt) ===
                    event.target.value,
                );
                if (selected) void selectPlanSet(selected);
              }}
            >
              {planSets.map((item) => (
                <option
                  key={item.snapshotId || item.generatedAt}
                  value={item.snapshotId || item.generatedAt}
                >
                  {item.date}{" "}
                  {new Date(item.generatedAt).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </option>
              ))}
            </select>
          )}
          <button
            disabled={!data || !officialMatches.length || busy}
            onClick={preview}
          >
            {busy ? "计算中…" : "按当前盘口试算"}
          </button>
        </div>
      </header>
      <div className="purchase-kanban" aria-label="组合票历史统计">
        <div><span>已结算组合</span><b>{planStats.settled}</b></div>
        <div><span>中奖组合</span><b>{planStats.won}</b></div>
        <div><span>历史中奖率</span><b>{planStats.settled?`${planStats.rate.toFixed(1)}%`:"待积累"}</b></div>
        <div><span>模拟投入</span><b>¥{planStats.stake.toFixed(2)}</b></div>
        <div><span>模拟返还</span><b>¥{planStats.returned.toFixed(2)}</b></div>
      </div>
      {visiblePlanModules.map(module=>{
        const stats=moduleStats[module.id]||{settled:0,won:0,rate:0,stake:0,returned:0,net:0};
        return <section className={`purchase-plan-module purchase-plan-module-${module.id}`} key={module.id} aria-labelledby={`purchase-module-${module.id}`}>
          <header className="purchase-module-head">
            <div><h4 id={`purchase-module-${module.id}`}>{module.title}</h4><p>{module.description} · 当前批次 {module.definitions.length} 组</p></div>
            <div className="purchase-module-stats" aria-label={`${module.title}历史统计`}>
              <span>中奖 / 已结算<b>{stats.won} / {stats.settled}</b></span>
              <span>中奖率<b>{stats.settled?`${stats.rate.toFixed(1)}%`:"待积累"}</b></span>
              <span>投入 / 返还<b>¥{stats.stake.toFixed(2)} / ¥{stats.returned.toFixed(2)}</b></span>
              <span>净收益<b className={stats.net>0?"positive":stats.net<0?"negative":""}>{stats.net>0?"+":""}¥{stats.net.toFixed(2)}</b></span>
            </div>
          </header>
          <div className="purchase-plan-grid">
        {module.definitions.map((definition) => {
          const plan = planSet!.plans.find((item) => item.id === definition.id)!;
          return (
            <article
              className={`purchase-plan-card ${plan.status}`}
              key={definition.id}
            >
              <div className="purchase-plan-title">
                <span>{definition.title}</span>
                <b>{definition.rule}</b>
              </div>
              <>
                  <div className="purchase-summary">
                    <strong>{plan.passName}</strong>
                    <span>
                      注数 <b>{plan.betCount || 1} 注</b>
                    </span>
                    <span>
                      模型概率{" "}
                      <b>{(plan.estimatedProbability * 100).toFixed(2)}%</b>
                    </span>
                  </div>
                  <ol>
                    {plan.items.map((item) => (
                      <li key={`${item.matchId}-${item.market}`}>
                        <div>
                          <b>{item.matchId}</b>
                          <span>
                            {item.home} vs {item.away}
                          </span>
                        </div>
                        <div>
                          <small>{item.marketName}</small>
                          {(item.picks?.length ? item.picks : [{pick:item.pick,probability:item.probability,odd:item.odd}]).map(selection=><span className="purchase-selection" key={selection.pick}><strong>{selection.pick}</strong><em>{selection.odd.toFixed(2)} · {selection.probability.toFixed(1)}%</em></span>)}
                          {item.result && (
                            <i
                              className={
                                item.result === "命中"
                                  ? "won"
                                  : item.result === "未中"
                                    ? "lost"
                                    : "pending"
                              }
                            >
                              {item.actual || item.result} · {item.result}
                            </i>
                          )}
                        </div>
                      </li>
                    ))}
                  </ol>
                  <footer>
                    <span>投入 ¥{plan.stake.toFixed(2)}</span>
                    <span>最低净收益 ¥{(plan.minWinningProfit ?? ((plan.minWinningReturn ?? plan.theoreticalReturn)-plan.stake)).toFixed(2)}</span>
                    <span>最高净收益 ¥{(plan.maxWinningProfit ?? ((plan.maxWinningReturn ?? plan.theoreticalReturn)-plan.stake)).toFixed(2)}</span>
                    <strong>{planResult(plan)}</strong>
                  </footer>
              </>
            </article>
          );
        })}
          </div>
        </section>;
      })}
      {planSet && (
        <p className="purchase-plan-source">
          生成：{new Date(planSet.generatedAt).toLocaleString("zh-CN")} ·{" "}
          {planSet.source}
        </p>
      )}
      <p className="purchase-risk">
        页面展示的是基于生成时固定奖金的模拟投入与返还区间，不代表收益或命中保证；最终以实际出票和官方计奖为准。
      </p>
    </section>
  );
}

export default function TodayRecommendations() {
  const [data, setData] = useState<SavedPredictionSet | null>(null),
    [loadError, setLoadError] = useState("");
  const [count, setCount] = useState(2),
    [scoreCount, setScoreCount] = useState(2),
    [markets, setMarkets] = useState<RecommendationMarket[]>(["score"]),
    model: Model = "consensus",
    [groupCount, setGroupCount] = useState(1),
    [allowLow, setAllowLow] = useState(false),
    [results, setResults] = useState<Combination[]>([]),
    [generatedAt, setGeneratedAt] = useState(""),
    [generating, setGenerating] = useState(false),
    [generateError, setGenerateError] = useState(""),
    official = useOfficialMarkets(data);
  const [selectedMatchDate, setSelectedMatchDate] = useState("");
  useEffect(() => {
    let active=true;
    void readBrowserData<SavedPredictionSet|null>(PREDICTION_STORAGE_KEY,null).then(saved=>{
      if(!active)return;
      if (!saved) {
        setLoadError(
          "尚未找到已保存的 AI 预测。请先进入“AI预测”生成赔率预测，并完成 AI 复核。",
        );
        return;
      }
      const today = new Date(Date.now() + 8 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      if (saved.date !== today) {
        setLoadError(
          "已保存的预测不是今日数据，请返回“AI预测”刷新并重新复核。",
        );
        return;
      }
      if (
        !saved.predictionId || !Array.isArray(saved.matches) ||
        saved.matches.some((match) => match.predictionId !== saved.predictionId)
      ) {
        setLoadError(
          "旧预测缺少统一版本标识，请返回“AI预测”刷新；旧 AI 结果不会覆盖新盘口。",
        );
        return;
      }
      setData(saved);
    }).catch(()=>{if(active)setLoadError("已保存的预测数据无法读取，请返回“AI预测”重新生成。")});
    return()=>{active=false};
  }, []);
  const availableMatchDates = useMemo(
    () =>
      Array.from(
        new Set(
          (data?.matches || [])
            .map((match) => matchDateKey(match))
            .filter(Boolean),
        ),
      ).sort(),
    [data],
  );
  const availableMatchDateCounts = useMemo(
    () =>
      Object.fromEntries(
        availableMatchDates.map((date) => [
          date,
          (data?.matches || []).filter((match) => matchDateKey(match) === date)
            .length,
        ]),
      ),
    [availableMatchDates, data],
  );
  const effectiveMatchDate =
    selectedMatchDate && availableMatchDates.includes(selectedMatchDate)
      ? selectedMatchDate
      : "";
  const maxSelectedPass = Math.min(...markets.map((value) => marketMaxPass[value]));
  const selectionLabel = markets.length === 1 ? selectionUnit(markets[0]) : "选项";
  const buildCandidates = useCallback((currentMatches: OfficialMatch[], now = Date.now()): Candidate[] => {
    if (!data) return [];
    const live = new Map(
      currentMatches.map((match) => [officialKey(match), match]),
    );
    return data.matches
      .flatMap((match) => {
        const current = live.get(officialKey(match)),
          matchDate = matchDateKey(match, current),
          kickoff = parseZonedKickoff(current?.kickoffAt),
          sourceAt = Date.parse(match.sourceFetchedAt),
          policy = refreshPolicy(current?.kickoffAt);
        if (effectiveMatchDate && matchDate !== effectiveMatchDate) return [];
        if (
          match.officialMappingStatus !== "verified" ||
          !current ||
          String(current.matchStatus || "").toLowerCase() !== "selling" ||
          match.isMock ||
          !Number.isFinite(kickoff) ||
          kickoff <= now ||
          !Number.isFinite(sourceAt) ||
          sourceAt > now + 5 * 60000 || now - sourceAt > policy.maxPredictionAgeMs
        )
          return [];
        if (!allowLow && match.completeness < MIN_COMPLETENESS) return [];
        return markets.flatMap((market) => {
          const eligibility=current.marketEligibility?.[marketEligibilityNames[market]],cutoff=eligibility?.cutoffAt?parseZonedKickoff(eligibility.cutoffAt):kickoff;
          if(eligibility?.qualification!=="qualified"||String(eligibility.salesStatus||"").toLowerCase()!=="selling"||!eligibility.allowedPassCounts?.includes(count)||!Number.isFinite(cutoff)||cutoff<=now)return [];
          if(market==="hhad"&&(!String(eligibility.handicap??"").trim()||!String(match.handicap??"").trim()||Number(eligibility.handicap)!==Number(match.handicap)))return [];
          const selected = market === "score"
            ? mergeScores(match)
            : market === "had"
              ? { scores: match.hadProbabilities || [], singleModel: false }
              : market === "hhad"
                ? { scores: match.hhadProbabilities || [], singleModel: false }
                : market === "total" ? {
                    scores: match.totalGoalProbabilities || [],
                    singleModel: Boolean(match.singleModel),
                  } : {scores:match.halfFullProbabilities||[],singleModel:Boolean(match.singleModel)};
          if (!selected?.scores.length) return [];
          const scores = selected.scores
          .slice()
          .sort((a, b) => b.probability - a.probability)
          .slice(0, scoreCount);
          if (scores.length < scoreCount) return [];
          const coverage =
          scores.reduce((sum, item) => sum + item.probability, 0) / 100;
          return [{
            match,
            market,
            scores: priceRecommendationSelections(scores, market, current),
            coverage,
            confidence: match.confidence,
            completeness: selected.singleModel
              ? Math.max(1, match.completeness - 2)
              : match.completeness,
            singleModel: selected.singleModel,
          }];
        });
      })
      .sort(
        (a, b) =>
          b.coverage - a.coverage ||
          b.confidence - a.confidence ||
          b.completeness - a.completeness ||
          a.match.time.localeCompare(b.match.time),
      )
      .slice(0, MAX_COMBINATION_CANDIDATES);
  }, [
    data,
    markets,
    scoreCount,
    allowLow,
    count,
    effectiveMatchDate,
  ]);
  const candidates = useMemo(() => official.fetchedAt ? buildCandidates(official.matches) : [], [buildCandidates, official.matches, official.fetchedAt]);
  const availableCandidateMatches=new Set(candidates.map(item=>item.match.officialMatchId||item.match.id)).size;
  useEffect(() => {
    setResults([]); setGeneratedAt(""); setGenerateError("");
  }, [count, scoreCount, markets, groupCount, allowLow, effectiveMatchDate]);
  async function generate() {
    if (!data || generating) return;
    setGenerating(true); setGenerateError("");
    try {
      const latest = await refreshOfficialMarkets();
      if (!latest) throw new Error("当前体彩赔率获取失败，未重新生成；已有结果仍按其标注时间展示。");
      const now = Date.now(), fetchedAt = Date.parse(latest.fetchedAt);
      if (!Number.isFinite(fetchedAt) || now - fetchedAt > 60000 || fetchedAt > now + 60000) throw new Error("当前体彩赔率时间无效或已过期，请稍后重试。");
      const freshCandidates = buildCandidates(latest.matches, now);
      if (new Set(freshCandidates.map(item => item.match.officialMatchId || item.match.id)).size < count) {
        setResults([]);
        throw new Error("刷新后可售且预测有效的比赛不足，未生成组合。请刷新 AI 预测或调整筛选。");
      }
      const combos: Combination[] = combinations(freshCandidates, count)
      .filter((items)=>new Set(items.map(item=>item.match.officialMatchId||item.match.id)).size===items.length)
      .map((items) => ({
        items,
        probability: items.reduce(
          (product, item) => product * item.coverage,
          1,
        ),
        averageCompleteness:
          items.reduce((sum, item) => sum + item.completeness, 0) /
          items.length,
        oddsFetchedAt: latest.fetchedAt,
        returns: calculateRecommendationReturns(items.map(item => ({matchKey: officialKey(item.match), market: item.market, scores: item.scores}))),
      }))
      .sort(
        (a, b) =>
          b.probability - a.probability ||
          b.averageCompleteness - a.averageCompleteness,
      );
    setResults(combos.slice(0, groupCount));
      setGeneratedAt(new Date(now).toISOString());
    } catch (error) {
      setGenerateError(error instanceof Error ? error.message : "生成失败，请稍后重试。");
    } finally { setGenerating(false); }
  }
  return (
    <section className="recommendations-page">
      <div className="section-head">
        <div>
          <p className="eyebrow">TRACEABLE COMBINATIONS</p>
          <h2>今日推荐</h2>
          <p className="recommendation-intro">
            读取“AI预测”保存的不可变概率版本，不在本页重新融合。
            {data?.predictionId && ` 版本 ${data.predictionId}`}
          </p>
        </div>
        <a className="source-link" href="/predictions">
          查看预测来源 →
        </a>
      </div>
      {loadError && <div className="data-fallback">{loadError}</div>}
      <div className="recommendation-lottery-date">
        <label>
          <span>彩票日期</span>
          <select
            aria-label="推荐彩票日期"
            value={effectiveMatchDate}
            disabled={!availableMatchDates.length || generating}
            onChange={(event) => {
              setSelectedMatchDate(event.target.value);
              setResults([]);
            }}
          >
            <option value="">全部彩票日期</option>
            {availableMatchDates.map((date) => (
              <option key={date} value={date}>
                {formatMatchDay(date)} · {availableMatchDateCounts[date] || 0}场
              </option>
            ))}
          </select>
        </label>
        <div>
          <b>
            {effectiveMatchDate
              ? formatMatchDay(effectiveMatchDate)
              : "全部彩票日期"}
          </b>
          <span>
            按竞彩编号所属销售日筛选；周五凌晨后的比赛仍归入周五场次。
          </span>
        </div>
      </div>
      <DailyPurchasePlans
        data={data}
        officialMatches={official.matches}
        lotteryDate={effectiveMatchDate}
      />
      <div className="recommendation-controls">
        <fieldset disabled={generating}>
          <legend>推荐玩法</legend>
          <div className="choice-grid market-choices">
            {(["score", "had", "hhad", "total", "halfFull"] as RecommendationMarket[]).map(
              (value) => (
                <label
                  className={markets.includes(value) ? "selected" : ""}
                  key={value}
                >
                  <input
                    type="checkbox"
                    name={`recommendation-market-${value}`}
                    checked={markets.includes(value)}
                    onChange={() => {
                      const next=markets.includes(value)?markets.filter(item=>item!==value):[...markets,value];
                      if(!next.length)return;
                      setMarkets(next);
                      setCount((current)=>Math.min(current,...next.map(item=>marketMaxPass[item])));
                      if(next.some(item=>item==="had"||item==="hhad")&&scoreCount>2)setScoreCount(2);
                      setResults([]);
                    }}
                  />
                  <span>{marketNames[value]}</span>
                </label>
              ),
            )}
          </div>
          <small>
            可多选玩法并跨玩法生成组合；每个组合中的同一场比赛只会出现一次，半全场仅纳入官方资格有效且已保存完整概率的比赛。
        </small>
      </fieldset>
      <fieldset disabled={generating}>
        <legend>串关场次数</legend>
          <div className="choice-grid passes">
            {Array.from({ length: 8 }, (_, index) => index + 1).map((value) => (
              <label className={count === value ? "selected" : ""} key={value}>
                <input
                  type="radio"
                  name="pass-count"
                  checked={count === value}
                  disabled={
                    value > maxSelectedPass || availableCandidateMatches < value
                  }
                  onChange={() => setCount(value)}
                />
                <span>{passNames(value)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset disabled={generating}>
          <legend>每场选择数量</legend>
          <div className="choice-grid">
            {(markets.every(item=>item==="score"||item==="total"||item==="halfFull")
              ? [1, 2, 3]
              : [1, 2]
            ).map((value) => (
              <label
                className={scoreCount === value ? "selected" : ""}
                key={value}
              >
                <input
                  type="radio"
                  name="score-count"
                  checked={scoreCount === value}
                  onChange={() => setScoreCount(value)}
                />
                <span>
                  每场{value}个{selectionLabel}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="model-fieldset muted-model" disabled={generating}>
          <legend>预测版本</legend>
          <div className="choice-grid">
            <label className="selected">
              <input type="radio" checked readOnly />
              <span>统一概率版本</span>
            </label>
          </div>
          <small>
            {data?.version
              ? `${data.version.baseModelVersion} · ${data.version.calibrationVersion}${data.version.aiReviewVersion ? ` · ${data.version.aiReviewVersion}` : ""}`
              : "由 AI预测 页面生成后锁定"}
          </small>
        </fieldset>
        <fieldset disabled={generating}>
          <legend>推荐组数</legend>
          <div className="choice-grid">
            {[1, 2, 3].map((value) => (
              <label
                className={groupCount === value ? "selected" : ""}
                key={value}
              >
                <input
                  type="radio"
                  name="group-count"
                  checked={groupCount === value}
                  onChange={() => setGroupCount(value)}
                />
                <span>{value === 1 ? "仅生成1组" : `生成前${value}组`}</span>
              </label>
            ))}
          </div>
          <label className="advanced-toggle">
            <input
              type="checkbox"
              checked={allowLow}
              onChange={(event) => setAllowLow(event.target.checked)}
            />
            允许低完整度或双模型缺一的数据
          </label>
        </fieldset>
        <div className="generate-row">
          <div>
            <b>可用比赛 {availableCandidateMatches} 场 · 玩法候选 {candidates.length} 个</b>
            <span>
              {availableCandidateMatches < count
                ? `${effectiveMatchDate ? formatMatchDay(effectiveMatchDate) : "当前筛选"}只有 ${availableCandidateMatches} 场比赛具备完整预测数据，无法生成 ${count} 场组合。`
                : "已按覆盖概率、置信度、完整度和开赛时间排序"}
            </span>
          </div>
          <button
            disabled={!data || availableCandidateMatches < count || generating}
            onClick={generate}
          >
            {generating ? "读取体彩赔率…" : "生成推荐"}
          </button>
        </div>
      </div>
      {generateError && <div className="recommendation-odds-error" role="alert">{generateError}</div>}
      {!generateError && official.error && <p className="recommendation-odds-error" role="status">体彩赔率暂未更新：{official.error}。生成时会重新获取，不使用旧赔率冒充当前赔率。</p>}
      {results.length > 0 && (
        <div className="recommendation-results">
          {results.map((combo, index) => (
            <article
              className="combination-card"
              key={combo.items.map((item) => `${item.match.id}-${item.market}`).join("-")}
            >
              <header>
                <div>
                  <span>第 {index + 1} 组</span>
                  <h3>
                    {passNames(combo.items.length)} · {Array.from(new Set(combo.items.map(item=>marketNames[item.market]))).join(" + ")} · 每场
                    {scoreCount}个{selectionLabel}
                  </h3>
                  <small>
                    {modelNames[model]}
                    {generatedAt &&
                      ` · ${new Date(generatedAt).toLocaleString("zh-CN")}`}
                  </small>
                </div>
                <div>
                  <span>组合估算概率</span>
                  <strong>{(combo.probability * 100).toFixed(3)}%</strong>
                  <small>
                    平均完整度 {combo.averageCompleteness.toFixed(1)}/10
                  </small>
                </div>
              </header>
              <div className="recommended-matches">
                {combo.items.map((item) => (
                  <section key={item.match.id}>
                    <div className="recommended-match-head">
                      <div>
                        <b>{item.match.id}</b>
                        <span>{item.match.league}</span>
                        <time>{item.match.time.slice(5, 16)}</time>
                      </div>
                      <h4>
                        {item.match.home}
                        <i>VS</i>
                        {item.match.away}
                      </h4>
                    </div>
                    <div className="recommended-scores">
                      <small>{marketNames[item.market]}</small>
                      {item.scores.map((score) => (
                        <span key={score.score}>
                          <b>{score.score}</b>
                          <em>模型 {score.probability.toFixed(1)}%</em>
                          <small className={score.odd === null ? "selection-odd missing" : "selection-odd"}>
                            {score.odd === null ? score.oddsReason : `体彩 SP ${score.odd.toFixed(2)}`}
                          </small>
                        </span>
                      ))}
                    </div>
                    <div className="recommended-metrics">
                      <span>
                        覆盖概率 <b>{(item.coverage * 100).toFixed(1)}%</b>
                      </span>
                      <span>
                        模型置信度 <b>{confidenceLabel(item.confidence)}</b>
                      </span>
                      <span>
                        数据完整度 <b>{item.completeness}/10</b>
                      </span>
                      {item.singleModel && (
                        <span className="single-model">仅有单模型数据</span>
                      )}
                    </div>
                    <p>
                      <b>关键理由：</b>
                      {item.market === "score"
                        ? item.match.aiSummary ||
                          `该场前 ${scoreCount} 个原始比分概率合计在当前候选中排名靠前。`
                        : item.market === "had"
                          ? `胜平负模型中“${item.scores.map((value) => value.score).join("、")}”的概率覆盖在当前候选中靠前。`
                          : item.market === "hhad"
                            ? `体彩让球 ${item.match.handicap || "—"} 场景中，“${item.scores.map((value) => value.score).join("、")}”去水概率覆盖较高。`
                            : item.market === "total"
                              ? `总进球模型中“${item.scores.map((value) => value.score).join("、")}”的累计覆盖概率在当前候选中靠前。`
                              : `半全场模型中“${item.scores.map((value) => value.score).join("、")}”的累计覆盖概率在当前候选中靠前。`}
                    </p>
                    <a href="/predictions">查看AI分析详情 →</a>
                  </section>
                ))}
              </div>
              <div className="recommendation-return-panel">
                <div className="recommendation-return-heading">
                  <b>1 倍 · 每注 2 元 · 共 {combo.returns.betCount} 注</b>
                  <span>体彩赔率获取：{new Date(combo.oddsFetchedAt).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai"})}</span>
                </div>
                <div className="recommendation-return-grid">
                  <div><span>本组总投入</span><strong>¥{combo.returns.totalStake.toFixed(2)}</strong></div>
                  <div><span>最高盈利（中奖时）</span><strong className={combo.returns.status === "ready" && combo.returns.maxWinningProfit >= 0 ? "positive" : "negative"}>{combo.returns.status === "ready" ? `¥${combo.returns.maxWinningProfit.toFixed(2)}` : "待补赔率"}</strong></div>
                  <div><span>最低盈利（中奖时）</span><strong className={combo.returns.status === "ready" && combo.returns.minWinningProfit >= 0 ? "positive" : "negative"}>{combo.returns.status === "ready" ? `¥${combo.returns.minWinningProfit.toFixed(2)}` : "待补赔率"}</strong></div>
                  <div><span>未中奖时净亏损</span><strong className="negative">¥{combo.returns.worstCaseProfit.toFixed(2)}</strong></div>
                </div>
                {combo.returns.status === "ready" ? <p>
                  中奖返还 ¥{combo.returns.minWinningReturn.toFixed(2)}～¥{combo.returns.maxWinningReturn.toFixed(2)}；净盈利已扣除本组全部 {combo.returns.betCount} 注的成本。
                  {combo.returns.capped && ` 已按单注最高奖金限额 ¥${combo.returns.bonusCap.toLocaleString("zh-CN")} 封顶。`}
                </p> : <p className="missing-odds">有 {combo.returns.missingOdds.length} 个推荐选项缺少对应体彩赔率，本组暂不计算盈利范围，不以模型赔率替代。</p>}
              </div>
            </article>
          ))}
        </div>
      )}
      <div className="independence-note">
        <b>概率说明</b>
        <p>
          同一场多个比分、总进球数或赛果选项互斥，覆盖概率采用加法；不同比赛暂按相互独立处理，组合概率采用各场覆盖概率的小数乘积。组合概率是模型估算值，共同因素可能造成相关性，实际概率不一定等于简单乘积，也不构成命中保证。
        </p>
        <p>盈利为税前情景测算：每场选项数相乘得到注数，总投入＝注数×2元；中奖返还按每场命中选项的体彩 SP 连乘×2元计算。“中奖时最低”不是保底收益，未中奖可能损失本组全部投入。各组独立计算，不合并重叠方案；实际奖金以出票赔率及官方无效场次、限额等规则为准。 <a href="https://m.sporttery.cn/bzzx/20210207/3273604.html?gid=3" target="_blank" rel="noreferrer">体彩计奖规则</a></p>
      </div>
    </section>
  );
}
