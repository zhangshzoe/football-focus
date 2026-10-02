"use client";

import { useRef } from "react";
import PredictionMarketSignals from "./PredictionMarketSignals";
import ModelHealthPanel from "./ModelHealthPanel";
import PredictionCoverage, {
  type PredictionCoverageSummary,
  type UnavailablePredictionMatch,
} from "./PredictionCoverage";
import { predictionKickoffParts, type AiEvidenceSummary } from "../prediction-config";
import AiEvidencePanel from "./AiEvidencePanel";

type CompanyPredictionOdds = {
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
type ScorePrediction = { score: string; probability: number };
type MarketSignal = {
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
export type AiPredictionRow = {
  aiEvidenceSummary?: AiEvidenceSummary;
  matchContext?: any;
  teamStrengthCandidate?: any;
  id: string;
  externalDisplayId?: string;
  league: string;
  time: string;
  matchDate?: string;
  kickoffAt?: string;
  home: string;
  away: string;
  matchStatus?: string;
  isMock?: boolean;
  sourceUpdatedAt?: string;
  companies: CompanyPredictionOdds[];
  probabilities: { home: number; draw: number; away: number };
  consensus: { handicap: number; totalLine: number; agreement: string };
  marketSignal?: MarketSignal;
  expectedGoals: { home: number; away: number };
  scores: ScorePrediction[];
  oddsScores?: ScorePrediction[];
  intelligenceScores?: ScorePrediction[];
  missingCompanies: number[];
  aiSummary?: string;
  aiRisk?: string;
};

type ProbabilityItem = { label: string; probability: number };
type Props = {
  rows: AiPredictionRow[];
  researchOnly?: boolean;
  coverage?: PredictionCoverageSummary | null;
  unavailableMatches?: UnavailablePredictionMatch[];
  loading: boolean;
  error: string;
  aiError: string;
  fetchedAt: string;
  sourceUrl: string;
  methodology: string;
  aiProvider: string;
  aiLoading: boolean;
  onAiReview: () => void;
  onRetryUnavailable?: () => void;
  retryingUnavailable?: boolean;
  retryMessage?: string;
};

const totalGoalLabels = ["0球", "1球", "2球", "3球", "4球", "5球", "6球", "7+球"];
const halfFullLabels = ["胜胜", "胜平", "胜负", "平胜", "平平", "平负", "负胜", "负平", "负负"];
const fixed = (value: number, digits = 1) => (Number.isFinite(value) ? value.toFixed(digits) : "—");
const line = (value: number) => (Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value}` : "—");
const ranked = (labels: string[], values: number[] | undefined, limit = 3): ProbabilityItem[] =>
  (values || [])
    .map((probability, index) => ({ label: labels[index] || `选项${index + 1}`, probability }))
    .filter((item) => Number.isFinite(item.probability))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, limit);

function ProbabilitySummary({
  title,
  items,
  note,
  className = "",
  emptyLabel = "数据待接入",
}: {
  title: string;
  items: ProbabilityItem[];
  note?: string;
  className?: string;
  emptyLabel?: string;
}) {
  return (
    <section className={`compact-market-summary ${className}`}>
      <header>
        <small>{title}</small>
        {note && <span>{note}</span>}
      </header>
      <div>
        {items.length ? (
          items.map((item, index) => (
            <span className={index === 0 ? "top" : ""} key={item.label}>
              <b>{item.label}</b>
              <em>{fixed(item.probability)}%</em>
            </span>
          ))
        ) : (
          <span className="empty-value">{emptyLabel}</span>
        )}
      </div>
    </section>
  );
}

function MatchContext({ row }: { row: AiPredictionRow }) {
  const context = row.matchContext,
    candidate = row.teamStrengthCandidate;
  if (!context) return <p>比赛背景资料尚未采集；不使用AI补造。</p>;
  return (
    <section className="market-signal-panel">
      <h4>冻结赛事资料与球队候选</h4>
      <p>同一来源的多个接口不构成独立证据共识；球队候选仅作影子研究。</p>
      <p>
        {context.observedAt
          ? `读取 ${new Date(context.observedAt).toLocaleString("zh-CN")}；来源发布时间未知。`
          : "赛事资料未取得。"}
      </p>
      {["home", "away"].map((side) => {
        const value = context.recent?.[side];
        return (
          <p key={side}>
            {side === "home" ? row.home : row.away}：
            {value?.matches
              ? `近 ${value.matches} 场进 ${value.goalsFor} / 失 ${value.goalsAgainst}；同主客场 ${value.venue.matches} 场；休息 ${value.restCalendarDays ?? "未知"} 日历天`
              : "真实赛果不足"}
          </p>
        );
      })}
      <p>
        伤停来源记录：
        {context.injuries?.length
          ? context.injuries
              .map((r: any) => `${r.player}（${r.position || "位置未知"}）`)
              .join("；")
          : "未取得可核验球员记录，不代表无人伤停"}
      </p>
      <p>
        后续赛程：
        {context.schedule?.length
          ? context.schedule
              .map((r: any) => `${r.side === "home" ? row.home : row.away} ${r.date}`)
              .join("；")
          : "未取得"}
      </p>
      <p>
        首发：
        {context.lineup
          ? `来源已公布（${context.lineup.observedAt}），主队 ${context.lineup.home.map((p: any) => p.name).join("、")}；客队 ${context.lineup.away.map((p: any) => p.name).join("、")}`
          : "未取得确认首发，不预测替代"}
      </p>
      <details>
        <summary>官方赔率时间序列（变更时间与读取时间分列）</summary>
        {context.oddsTimeline?.length ? (
          context.oddsTimeline.slice(-24).map((p: any) => (
            <p key={`${p.market}-${p.quoteAt}`}>
              {p.market} · 变更 {p.quoteAt} · 赔率 {p.prices.join(" / ")} · 读取 {p.observedAt}
            </p>
          ))
        ) : (
          <p>尚未取得带时间的官方序列；外围初/即盘无时间不能伪装成完整走势。</p>
        )}
      </details>
      <p>
        缺失：{context.missing?.join("、") || "无"}。{context.limitations}
      </p>
      <p>
        对手强度调整球队模型：
        {candidate?.status === "ready"
          ? `真实历史 ${candidate.sampleSize} 场；影子预期进球 ${fixed(candidate.expectedGoals.home, 2)} : ${fixed(candidate.expectedGoals.away, 2)}（无盘口输入，尚未通过未来验证，不影响推荐）`
          : "样本不足，未生成球队强度候选"}
      </p>
      {context.sources?.map((source: any) => (
        <a key={source.sourceUrl} href={source.sourceUrl} target="_blank" rel="noreferrer">
          {source.kind} ↗　
        </a>
      ))}
    </section>
  );
}

function PredictionOverview({
  row,
  children,
}: {
  row: AiPredictionRow;
  children: React.ReactNode;
}) {
  const region = useRef<HTMLDivElement>(null);
  const move = (direction: number) => {
    const node = region.current;
    if (node) node.scrollBy({ left: direction * node.clientWidth * 0.9, behavior: "smooth" });
  };
  return (
    <>
      <div className="prediction-overview-scroll-hint">
        <span>左右滑动查看 5 类预测</span>
        <div className="prediction-overview-controls">
          <button type="button" aria-label={`${row.id} 查看上一类预测`} onClick={() => move(-1)}>
            ‹
          </button>
          <button type="button" aria-label={`${row.id} 查看下一类预测`} onClick={() => move(1)}>
            ›
          </button>
        </div>
      </div>
      <div
        ref={region}
        className="prediction-overview-grid"
        role="region"
        aria-label={`${row.id} 五类预测，可左右滑动查看`}
        tabIndex={0}
      >
        {children}
      </div>
    </>
  );
}

export default function AiPredictionReport({
  rows,
  researchOnly = false,
  coverage,
  unavailableMatches,
  loading,
  error,
  aiError,
  fetchedAt,
  sourceUrl,
  methodology,
  aiProvider,
  aiLoading,
  onAiReview,
  onRetryUnavailable,
  retryingUnavailable,
  retryMessage,
}: Props) {
  return (
    <section className="predictions-page compact-predictions-page">
      <div className="section-head prediction-report-head">
        <div>
          <p className="eyebrow">DAILY SCORE OUTLOOK</p>
          <h2>{researchOnly ? "外围赛事研究（未匹配体彩）" : "今日比分预测报告"}</h2>
          <p>
            {researchOnly
              ? "仅使用外围欧赔、亚洲盘和大小球；竞彩五玩法赔率暂缺"
              : "体彩赔率 + 36*、ＳＢ/*、平* 欧亚大小球联动"}
          </p>
        </div>
        <div className="prediction-actions">
          <button onClick={onAiReview} disabled={loading || aiLoading || !rows.length}>
            {aiLoading ? "AI 正在分批复核…" : researchOnly ? "AI 复核外围赛事" : "AI 复核全部比赛"}
          </button>
          {sourceUrl && (
            <a href={sourceUrl} target="_blank" rel="noreferrer">
              赔率来源 ↗
            </a>
          )}
        </div>
      </div>
      {researchOnly && (
        <div className="data-fallback" role="status">
          以下编号、球队和盘口来自外围数据源，尚未通过竞彩官方赛事身份及销售资格核验。概率仅供研究，不参与选号、每日固定票或正式赛前复盘。
        </div>
      )}
      {error && <div className="data-fallback">{error}</div>}
      {aiError && (
        <div className="data-fallback">
          AI 复核未完成：{aiError}；当前仍展示可用的赔率模型基线。
        </div>
      )}
      <div className="prediction-disclaimer">
        <b>{aiProvider ? `已由 ${aiProvider} 复核` : "赔率模型基线（尚未调用 AI 复核）"}</b>
        <span className="prediction-methodology-desktop">{methodology}</span>
        <details className="prediction-methodology-mobile">
          <summary>查看模型口径与数据限制</summary>
          <span>{methodology}</span>
        </details>
        {fetchedAt && <small>数据读取 {new Date(fetchedAt).toLocaleString("zh-CN")}</small>}
      </div>
      {!researchOnly && <ModelHealthPanel />}
      {!researchOnly && !loading && (
        <PredictionCoverage
          coverage={coverage}
          unavailableMatches={unavailableMatches}
          predictedCount={rows.length}
          onRetry={onRetryUnavailable}
          retrying={retryingUnavailable}
          retryMessage={retryMessage}
        />
      )}
      {loading ? (
        <div className="results-empty">正在同步三家公司赔率并计算全部场次…</div>
      ) : (
        <div className="daily-prediction-list">
          {rows.map((row, index) => {
            const had = ranked(
              ["胜", "平", "负"],
              [row.probabilities.home, row.probabilities.draw, row.probabilities.away],
              3,
            );
            const hhad = ranked(["让胜", "让平", "让负"], row.marketSignal?.modeledHhad, 3);
            const goals = ranked(totalGoalLabels, row.marketSignal?.modeledTotalGoals, 3);
            const halfFull = ranked(halfFullLabels, row.marketSignal?.modeledHalfFull, 3);
            return (
              <article className="daily-prediction-card compact" key={row.id}>
                <header>
                  <div>
                    <span className="prediction-rank">#{index + 1}</span>
                    <b>{researchOnly ? `外围 ${row.externalDisplayId || row.id}` : row.id}</b>
                    <span className="prediction-league">{row.league}</span>
                    <time>{predictionKickoffParts(row).label}</time>
                  </div>
                  <h3>
                    <strong>{row.home}</strong>
                    <i>VS</i>
                    <strong>{row.away}</strong>
                  </h3>
                  <span
                    className={
                      row.consensus.agreement === "较一致" ? "agreement good" : "agreement"
                    }
                  >
                    {row.consensus.agreement}
                  </span>
                </header>
                <PredictionOverview row={row}>
                  <section className="compact-score-summary">
                    <header>
                      <small>比分预测</small>
                      <span>原始概率</span>
                    </header>
                    <div>
                      {row.scores.map((score, scoreIndex) => (
                        <span className={scoreIndex === 0 ? "top" : ""} key={score.score}>
                          <small>{scoreIndex === 0 ? "首选" : "候选"}</small>
                          <b>{score.score}</b>
                          <em>{fixed(score.probability)}%</em>
                        </span>
                      ))}
                    </div>
                  </section>
                  <ProbabilitySummary title="胜平负" items={had} />
                  <ProbabilitySummary
                    title="体彩让球"
                    items={hhad}
                    note={row.marketSignal?.officialHandicap || "官方玩法不可用"}
                    emptyLabel="不可执行"
                  />
                  <ProbabilitySummary title="总进球" items={goals} />
                  <ProbabilitySummary
                    title="半全场（近似）"
                    items={halfFull}
                    className="half-full-summary"
                  />
                </PredictionOverview>
                <div className="prediction-evidence compact-evidence">
                  <div>
                    <small>盘口中位数</small>
                    <b>
                      主队 {line(row.consensus.handicap)} · 总球 {row.consensus.totalLine}
                    </b>
                  </div>
                  <div>
                    <small>盘口隐含进球（非射门 xG）</small>
                    <b>
                      {fixed(row.expectedGoals.home, 2)} : {fixed(row.expectedGoals.away, 2)}
                    </b>
                  </div>
                  <div>
                    <small>方向摘要</small>
                    <b>{row.marketSignal?.direction || "等待盘口数据"}</b>
                  </div>
                </div>
                <p className="prediction-footnote">
                  五类输出由同一比分分布派生，不是独立模型投票；半全场为条件二项分配近似。
                </p>
                <details className="prediction-full-details">
                  <summary>
                    <span>
                      {researchOnly
                        ? "外围盘口、三家公司变盘与风险分析"
                        : "完整盘口、三家公司变盘与风险分析"}
                    </span>
                    <small>点击展开</small>
                  </summary>
                  <div className="prediction-detail-body">
                    <PredictionMarketSignals row={row} />
                    <MatchContext row={row} />
                    {row.aiEvidenceSummary && <AiEvidencePanel summary={row.aiEvidenceSummary} />}
                    {!row.aiEvidenceSummary && row.aiSummary && (
                      <p className="ai-review">
                        <b>AI 证据摘要：</b>
                        {row.aiSummary}
                      </p>
                    )}
                    {!row.aiEvidenceSummary && row.aiRisk && (
                      <p className="ai-risk">
                        <b>最大风险：</b>
                        {row.aiRisk}
                      </p>
                    )}
                    {row.missingCompanies.length > 0 && (
                      <p className="missing-source">
                        缺少公司编号 {row.missingCompanies.join("、")}{" "}
                        的当前赔率，本场输入覆盖不足，需谨慎评估。
                      </p>
                    )}
                  </div>
                </details>
              </article>
            );
          })}
        </div>
      )}
      <p className="prediction-footnote">
        {researchOnly
          ? "本页外围研究概率不是竞彩官方赔率或可购买建议；缺少独立赛前证据时，AI 文字复核不会改变数值概率。"
          : "概率为模型估计，比分与半全场摘要均使用原始分布，不会重新归一化为 100%。赔率变化反映市场预期，不代表确定赛果；临场伤停、首发、天气与裁判若未同步，应另行复核。"}
      </p>
    </section>
  );
}
