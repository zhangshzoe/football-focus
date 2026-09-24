"use client";

import PredictionMarketSignals from "./PredictionMarketSignals";
import ModelHealthPanel from "./ModelHealthPanel";
import PredictionCoverage,{type PredictionCoverageSummary,type UnavailablePredictionMatch} from "./PredictionCoverage";
import {predictionKickoffParts} from "../prediction-config";

type CompanyPredictionOdds={companyId:number;company:string;win:number;draw:number;lose:number;handicap:number;homePrice:number;awayPrice:number;total:number;overPrice:number;underPrice:number;firstWin:number;firstDraw:number;firstLose:number;firstHandicap:number;firstHomePrice:number;firstAwayPrice:number;firstTotal:number;firstOverPrice:number;firstUnderPrice:number};
type ScorePrediction={score:string;probability:number};
type MarketSignal={direction:string;strength:number;probabilityShifts:number[];fairOdds:number[];hadEv?:number[];hhadEv?:number[];evThreshold?:number;institutionAction?:string;handicapExpectation?:string;firstHandicap:number;handicapChange:number;narrative:string;officialOdds:number[];officialHandicap:string;officialHhadOdds:number[];officialHhadFair:number[];modeledHhad:number[];hhadAvailable?:boolean;modeledTotalGoals?:number[];modeledHalfFull?:number[];asianHomeProbability:number;asianAwayProbability:number;asianMovement:number;overProbability:number;fitAgreement:string;handicapMeaning:string};
export type AiPredictionRow={id:string;league:string;time:string;matchDate?:string;kickoffAt?:string;home:string;away:string;matchStatus?:string;isMock?:boolean;sourceUpdatedAt?:string;companies:CompanyPredictionOdds[];probabilities:{home:number;draw:number;away:number};consensus:{handicap:number;totalLine:number;agreement:string};marketSignal?:MarketSignal;expectedGoals:{home:number;away:number};scores:ScorePrediction[];oddsScores?:ScorePrediction[];intelligenceScores?:ScorePrediction[];missingCompanies:number[];aiSummary?:string;aiRisk?:string};

type ProbabilityItem={label:string;probability:number};
type Props={
  rows:AiPredictionRow[];
  coverage?:PredictionCoverageSummary|null;
  unavailableMatches?:UnavailablePredictionMatch[];
  loading:boolean;
  error:string;
  aiError:string;
  fetchedAt:string;
  sourceUrl:string;
  methodology:string;
  aiProvider:string;
  aiLoading:boolean;
  onAiReview:()=>void;
  onRetryUnavailable?:()=>void;
  retryingUnavailable?:boolean;
  retryMessage?:string;
};

const totalGoalLabels=["0球","1球","2球","3球","4球","5球","6球","7+球"];
const halfFullLabels=["胜胜","胜平","胜负","平胜","平平","平负","负胜","负平","负负"];
const fixed=(value:number,digits=1)=>Number.isFinite(value)?value.toFixed(digits):"—";
const line=(value:number)=>Number.isFinite(value)?`${value>0?"+":""}${value}`:"—";
const ranked=(labels:string[],values:number[]|undefined,limit=3):ProbabilityItem[]=>(values||[])
  .map((probability,index)=>({label:labels[index]||`选项${index+1}`,probability}))
  .filter(item=>Number.isFinite(item.probability))
  .sort((a,b)=>b.probability-a.probability)
  .slice(0,limit);

function ProbabilitySummary({title,items,note,className="",emptyLabel="数据待接入"}:{title:string;items:ProbabilityItem[];note?:string;className?:string;emptyLabel?:string}){
  return <section className={`compact-market-summary ${className}`}>
    <header><small>{title}</small>{note&&<span>{note}</span>}</header>
    <div>{items.length?items.map((item,index)=><span className={index===0?"top":""} key={item.label}><b>{item.label}</b><em>{fixed(item.probability)}%</em></span>):<span className="empty-value">{emptyLabel}</span>}</div>
  </section>;
}

export default function AiPredictionReport({rows,coverage,unavailableMatches,loading,error,aiError,fetchedAt,sourceUrl,methodology,aiProvider,aiLoading,onAiReview,onRetryUnavailable,retryingUnavailable,retryMessage}:Props){
  return <section className="predictions-page compact-predictions-page">
    <div className="section-head prediction-report-head">
      <div><p className="eyebrow">DAILY SCORE OUTLOOK</p><h2>今日比分预测报告</h2><p>体彩赔率 + 36*、ＳＢ/*、平* 欧亚大小球联动</p></div>
      <div className="prediction-actions"><button onClick={onAiReview} disabled={loading||aiLoading||!rows.length}>{aiLoading?"AI 正在分批复核…":"AI 复核全部比赛"}</button>{sourceUrl&&<a href={sourceUrl} target="_blank" rel="noreferrer">赔率来源 ↗</a>}</div>
    </div>
    {error&&<div className="data-fallback">{error}</div>}
    {aiError&&<div className="data-fallback">AI 复核未完成：{aiError}；当前仍展示可用的赔率模型基线。</div>}
    <div className="prediction-disclaimer"><b>{aiProvider?`已由 ${aiProvider} 复核`:"赔率模型基线（尚未调用 AI 复核）"}</b><span className="prediction-methodology-desktop">{methodology}</span><details className="prediction-methodology-mobile"><summary>查看模型口径与数据限制</summary><span>{methodology}</span></details>{fetchedAt&&<small>数据读取 {new Date(fetchedAt).toLocaleString("zh-CN")}</small>}</div>
    <ModelHealthPanel/>
    {!loading&&<PredictionCoverage coverage={coverage} unavailableMatches={unavailableMatches} predictedCount={rows.length} onRetry={onRetryUnavailable} retrying={retryingUnavailable} retryMessage={retryMessage}/>}
    {loading?<div className="results-empty">正在同步三家公司赔率并计算全部场次…</div>:<div className="daily-prediction-list">
      {rows.map((row,index)=>{
        const had=ranked(["胜","平","负"],[row.probabilities.home,row.probabilities.draw,row.probabilities.away],3);
        const hhad=ranked(["让胜","让平","让负"],row.marketSignal?.modeledHhad,3);
        const goals=ranked(totalGoalLabels,row.marketSignal?.modeledTotalGoals,3);
        const halfFull=ranked(halfFullLabels,row.marketSignal?.modeledHalfFull,3);
        return <article className="daily-prediction-card compact" key={row.id}>
          <header>
            <div><span className="prediction-rank">#{index+1}</span><b>{row.id}</b><span className="prediction-league">{row.league}</span><time>{predictionKickoffParts(row).label}</time></div>
            <h3><strong>{row.home}</strong><i>VS</i><strong>{row.away}</strong></h3>
            <span className={row.consensus.agreement==="较一致"?"agreement good":"agreement"}>{row.consensus.agreement}</span>
          </header>
          <p className="prediction-overview-scroll-hint" aria-hidden="true">左右滑动查看 5 类预测</p>
          <div className="prediction-overview-grid" role="region" aria-label={`${row.id} 五类预测，可左右滑动查看`} tabIndex={0}>
            <section className="compact-score-summary">
              <header><small>比分预测</small><span>原始概率</span></header>
              <div>{row.scores.map((score,scoreIndex)=><span className={scoreIndex===0?"top":""} key={score.score}><small>{scoreIndex===0?"首选":"候选"}</small><b>{score.score}</b><em>{fixed(score.probability)}%</em></span>)}</div>
            </section>
            <ProbabilitySummary title="胜平负" items={had}/>
            <ProbabilitySummary title="体彩让球" items={hhad} note={row.marketSignal?.officialHandicap||"官方玩法不可用"} emptyLabel="不可执行"/>
            <ProbabilitySummary title="总进球" items={goals}/>
            <ProbabilitySummary title="半全场" items={halfFull} className="half-full-summary"/>
          </div>
          <div className="prediction-evidence compact-evidence">
            <div><small>盘口中位数</small><b>主队 {line(row.consensus.handicap)} · 总球 {row.consensus.totalLine}</b></div>
            <div><small>模型预期进球</small><b>{fixed(row.expectedGoals.home,2)} : {fixed(row.expectedGoals.away,2)}</b></div>
            <div><small>方向摘要</small><b>{row.marketSignal?.direction||"等待盘口数据"}</b></div>
          </div>
          {row.aiSummary&&<p className="ai-review compact-ai-review"><b>AI 联动判断：</b>{row.aiSummary}</p>}
          <details className="prediction-full-details">
            <summary><span>完整盘口、三家公司变盘与风险分析</span><small>点击展开</small></summary>
            <div className="prediction-detail-body">
              <PredictionMarketSignals row={row}/>
              <div className="company-odds-table legacy-company-table"><div className="company-odds-row heading"><span>公司</span><span>主胜</span><span>平</span><span>客胜</span><span>让球</span><span>大小</span></div>{row.companies.map(company=><div className="company-odds-row" key={company.companyId}><b>{company.company}</b><span>{company.win.toFixed(2)}</span><span>{company.draw.toFixed(2)}</span><span>{company.lose.toFixed(2)}</span><span>{line(company.handicap)}</span><span>{company.total}</span></div>)}</div>
              {row.aiSummary&&<p className="ai-review"><b>AI 联动判断：</b>{row.aiSummary}</p>}
              {row.aiRisk&&<p className="ai-risk"><b>最大风险：</b>{row.aiRisk}</p>}
              {row.missingCompanies.length>0&&<p className="missing-source">缺少公司编号 {row.missingCompanies.join("、")} 的当前赔率，本场置信度已降低。</p>}
            </div>
          </details>
        </article>;
      })}
    </div>}
    <p className="prediction-footnote">概率为模型估计，比分与半全场摘要均使用原始分布，不会重新归一化为 100%。赔率变化反映市场预期，不代表确定赛果；临场伤停、首发、天气与裁判若未同步，应另行复核。</p>
  </section>;
}
