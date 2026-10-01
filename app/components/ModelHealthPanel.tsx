"use client";

import {useEffect,useState} from "react";

type Metric={eligible:number;rate:number|null};
type AuditPayload={
 audit?:{
  generatedAt?:string;
  inventory?:{snapshotCount:number;uniqueSettledMatches:number;strictDecisionRows:number;fallbackDecisionRows:number};
  completeness?:{marketHadBaseline?:{rate:number};validIntelligenceEvidence?:{rate:number};fullScoreDistribution?:{rate:number}};
  overall?:{hadTop1:Metric;scoreTop3:Metric;totalTop2:Metric;modelBrier:number|null;marketBrier:number|null;marketComparable?:number};
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
 return <section className="model-health-panel" aria-label="模型与数据健康">
  <header><div><small>HISTORICAL MODEL CHECK</small><h3>历史审计（非实时验证）</h3><p>审计生成于 {audit.generatedAt||"未知"}；诊断口径包含旧快照，严格决策记录和回退记录分列；历史成绩用于发现偏差，不作为命中保证或未来验证。</p></div><span className={calibration?.status==="validated"?"model-status validated":"model-status shadow"}>{calibration?.status==="validated"?`正式校准 ${calibration.profileId}`:"未加载正式校准（研究候选另列）"}</span></header>
  <div className="model-health-grid">
   <article><small>严格历史决策诊断记录</small><b>{inventory?.strictDecisionRows||0} 条</b><span>已结算去重比赛 {inventory?.uniqueSettledMatches||0} 场 · 回退记录 {inventory?.fallbackDecisionRows||0} 条；去重不证明统计独立。</span></article>
   <article className="attention"><small>历史诊断概率评分（旧口径）</small><b>模型 {score(overall?.modelBrier)} / {overall?.hadTop1?.eligible??"—"} 场</b><span>市场基线 {score(overall?.marketBrier)} / {overall?.marketComparable??"—"} 场；旧口径未保证同场配对，不能据此判断领先。</span></article>
   <article><small>历史结果覆盖（各玩法分母分列）</small><b>胜平负 {percent(overall?.hadTop1?.rate)} / {overall?.hadTop1?.eligible??"—"} 场</b><span>比分前三 {percent(overall?.scoreTop3?.rate)} / {overall?.scoreTop3?.eligible??"—"} 场 · 总进球前二 {percent(overall?.totalTop2?.rate)} / {overall?.totalTop2?.eligible??"—"} 场；小样本只作诊断。</span></article>
   <article className="attention"><small>AI 正式概率权重</small><b>0% · 仅文字复核</b><span>旧诊断可比较样本 {audit.aiContribution?.comparableMatches||0} 场；研究增益不自动改变正式权重。</span></article>
  </div>
  <details><summary>查看本轮改进与数据限制</summary><div className="model-improvement-list">
   <span><i className="done"/>官方比赛 ID、销售日、开赛时间贯穿全流程</span>
   <span><i className="done"/>新配对评分与排除明细请见模型实验中心</span>
   <span><i className="done"/>AI 文字复核不改动正式概率；数值候选须另行未来验证与签发</span>
   <span><i className="shadow"/>Dixon–Coles 低比分相关参数须通过冻结重放与未来验证后启用</span>
   <span><i className="shadow"/>旧格式快照只展示，不参与正式参数升级</span>
   <span><i className="shadow"/>该历史审计市场基线完整率 {percent(audit.completeness?.marketHadBaseline?.rate)}，AI有效证据率 {percent(audit.completeness?.validIntelligenceEvidence?.rate)}</span>
  </div></details>
 </section>;
}
