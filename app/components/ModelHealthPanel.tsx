"use client";

import {useEffect,useState} from "react";

type Metric={eligible:number;rate:number|null};
type AuditPayload={
 audit?:{
  generatedAt?:string;
  inventory?:{snapshotCount:number;uniqueSettledMatches:number;strictDecisionRows:number;fallbackDecisionRows:number};
  completeness?:{marketHadBaseline?:{rate:number};validIntelligenceEvidence?:{rate:number};fullScoreDistribution?:{rate:number}};
  overall?:{hadTop1:Metric;scoreTop3:Metric;totalTop2:Metric;modelBrier:number|null;marketBrier:number|null};
  aiContribution?:{comparableMatches:number;interpretation:string};
 };
 calibration?:{status?:string;profileId?:string;intelligenceWeightMultiplier?:number;global?:{lowScoreRho?:number}}|null;
 safeguards?:Record<string,string>;
};

const percent=(value:number|null|undefined)=>Number.isFinite(value)?`${Number(value).toFixed(1)}%`:"—";
const score=(value:number|null|undefined)=>Number.isFinite(value)?Number(value).toFixed(3):"—";

export default function ModelHealthPanel(){
 const [data,setData]=useState<AuditPayload|null>(null);
 useEffect(()=>{let active=true;fetch("/api/model-audit",{cache:"no-store"}).then(response=>response.ok?response.json():null).then(value=>{if(active)setData(value)}).catch(()=>{});return()=>{active=false}},[]);
 const audit=data?.audit,inventory=audit?.inventory,overall=audit?.overall,calibration=data?.calibration;
 if(!audit)return null;
 const marketLead=overall?.modelBrier!=null&&overall?.marketBrier!=null?overall.modelBrier-overall.marketBrier:null;
 return <section className="model-health-panel" aria-label="模型与数据健康">
  <header><div><small>HISTORICAL MODEL CHECK</small><h3>模型与数据健康</h3><p>只使用已结算、可追溯的赛前快照；历史成绩用于发现偏差，不作为命中保证。</p></div><span className={calibration?.status==="validated"?"model-status validated":"model-status shadow"}>{calibration?.status==="validated"?`正式校准 ${calibration.profileId}`:"候选参数影子验证中"}</span></header>
  <div className="model-health-grid">
   <article><small>严格未来评估样本</small><b>{inventory?.strictDecisionRows||0} 场</b><span>已结算独立比赛 {inventory?.uniqueSettledMatches||0} 场</span></article>
   <article className={marketLead!=null&&marketLead>0?"attention":"positive"}><small>胜平负概率质量</small><b>模型 {score(overall?.modelBrier)}</b><span>市场基线 {score(overall?.marketBrier)} · {marketLead==null?"待比较":marketLead>0?"模型暂未超越基线":"模型优于基线"}</span></article>
   <article><small>结果覆盖</small><b>胜平负 {percent(overall?.hadTop1?.rate)}</b><span>比分前三 {percent(overall?.scoreTop3?.rate)} · 总进球前二 {percent(overall?.totalTop2?.rate)}</span></article>
   <article className="attention"><small>AI 情报数值权重</small><b>{calibration?.intelligenceWeightMultiplier?`${calibration.intelligenceWeightMultiplier*40}% 上限`:`0% · 仅文字复核`}</b><span>可比较样本 {audit.aiContribution?.comparableMatches||0} 场，增益验证后才启用</span></article>
  </div>
  <details><summary>查看本轮改进与数据限制</summary><div className="model-improvement-list">
   <span><i className="done"/>官方比赛 ID、销售日、开赛时间贯穿全流程</span>
   <span><i className="done"/>市场基线与模型使用同场同刻 Brier / Log Loss 比较</span>
   <span><i className="done"/>AI 情报采用证据时效 + 未来增益双重门控</span>
   <span><i className="shadow"/>Dixon–Coles 低比分相关参数仅在足量历史验证后启用</span>
   <span><i className="shadow"/>旧格式快照只展示，不参与正式参数升级</span>
   <span><i className="shadow"/>当前市场基线完整率 {percent(audit.completeness?.marketHadBaseline?.rate)}，AI有效证据率 {percent(audit.completeness?.validIntelligenceEvidence?.rate)}</span>
  </div></details>
 </section>;
}
