"use client";
import {useState} from "react";
import {buildModelEvaluation} from "../model-evaluation.js";
import ForwardValidationPanel from "./ForwardValidationPanel";
import PredictionSlotComparison from "./PredictionSlotComparison";
import TotalGoalsValidationPanel from "./TotalGoalsValidationPanel";
type Report=ReturnType<typeof buildModelEvaluation>;
const pct=(v:number|null)=>v===null?"—":(v*100).toFixed(1)+"%";
const number=(v:number|null)=>v===null?"—":v.toFixed(3);
const interval=(v:any)=>v.delta===null?"无同场同刻样本":v.lower===null?`${number(v.delta)}（${v.sampleSize} 场 / ${v.clusters} 日，样本不足不报区间）`:`${number(v.delta)} [${number(v.lower)}, ${number(v.upper)}]（95%日期块重采样）`;
export default function ModelExperimentCenter({report}:{report:Report}){
 const [window,setWindow]=useState<"all"|"recent50"|"recent100">("recent100"),current=report.windows[window];
 return <section className="model-experiment-center"><header className="experiment-head"><div><small>固定决策时点 · 存档概率诊断</small><h3>模型实验中心</h3><p>使用实际取得时间，不以计划任务时间代替；本页不是冻结模型的未来验证，不能自动晋级。</p></div><div className="experiment-window-tabs">{(["recent50","recent100","all"] as const).map(k=><button key={k} onClick={()=>setWindow(k)} className={window===k?"active":""}>{k==="all"?"全部":k==="recent50"?"最近50场":"最近100场"}</button>)}</div></header>
 <p>已结算 {current.sampleSize} 场；正式模型与纯官方去水基线同场同刻 {current.pairedSampleSize} 场，缺少冻结官方输入的 {current.excludedUnpaired} 场不参与对照。</p>
 <div className="experiment-model-grid">{(["champion","market"] as const).map(k=>{const m=current[k];return <article className={`experiment-model-card ${k}`} key={k}><span>{k==="champion"?"正式模型":"纯官方赔率基线"}</span><strong>{number(m.brier)}</strong><small>Brier ↓ · {m.sampleSize} 场</small><p>Log Loss {number(m.logLoss)} · ECE {pct(m.ece)} · 命中率 {pct(m.hitRate)}</p></article>})}</div>
 <p>配对模型−市场：Brier {interval(current.brierInterval)}；Log Loss {interval(current.logLossInterval)}。负数较好；区间含0时不据此声称领先。</p>
 <details className="experiment-detail-block" open><summary>所有玩法完整概率评分（不是TopK覆盖率替代）</summary><div className="experiment-table-wrap"><table><thead><tr><th>玩法</th><th>完整样本</th><th>Brier ↓</th><th>Log Loss ↓</th><th>ECE ↓</th><th>RPS ↓</th><th>配对场次</th><th>配对Brier差</th></tr></thead><tbody>{Object.entries(current.markets).map(([key,m]:[string,any])=><tr key={key}><td>{{score:"完整比分0–12",scoreOfficial:"体彩31类比分",hhad:"让球",total:"总进球8类",halfFull:"半全场9类"}[key]}</td><td>{m.sampleSize}</td><td>{number(m.brier)}</td><td>{number(m.logLoss)}</td><td>{pct(m.ece)}</td><td>{number(m.rps)}</td><td>{m.paired.sampleSize}</td><td>{interval(m.paired.brierInterval)}</td></tr>)}</tbody></table></div><p>精确比分按当前0–12球支持集评分，超出支持集不补造；体彩比分包括“其他”。旧快照只存摘要时显示无完整样本。</p></details>
 <details className="experiment-detail-block"><summary>影子候选与晋级条件</summary><p>影子候选只有在目标时点前完成才参与：三方对齐 {current.challengerComparison.sampleSize} 场；正式 {number(current.challengerComparison.champion.brier)} / 影子 {number(current.challengerComparison.challenger.brier)} / 市场 {number(current.challengerComparison.market.brier)}。该样本池不同于上方正式/市场池。</p>{report.promotion.gates.map(g=><p key={g.key}>{g.passed?"✓":"待验证"} {g.label}：{g.value}</p>)}<p>球队强度、低比分/尾部与半全场候选均需原始输入冻结重放、分项消融和未来验证，不会因单场赛果改变正式权重。</p></details>
 <details className="experiment-detail-block" open><summary>采集健康与排除原因</summary><p>分母范围：{report.dataHealth.denominatorScope==="saved-official-fixture-manifests"?"已保存官方场次清单":"已归档场次，不能推断全部应预测比赛"}；预期 {report.dataHealth.expectedFixtures} / 取得 {report.dataHealth.capturedFixtures} / 决策有效 {report.dataHealth.decisionEligibleFixtures}；到期缺赛果 {report.dataHealth.missingDueResults} / 尚待赛果 {report.dataHealth.pendingResultFixtures}。</p><p>完整预测 {pct(report.dataHealth.completeCoverage)}；官方市场 {pct(report.dataHealth.marketCoverage)}；到期赛果 {pct(report.dataHealth.resultCoverage)}。</p><p>{Object.entries(report.dataHealth.excludedByReason).map(([r,n])=>`${r}：${n}`).join("；")||"无排除记录"}</p></details>
 <details className="experiment-detail-block"><summary>联赛、最高概率与提前量分层</summary>{[report.segments.leagues,report.segments.confidenceBands,report.segments.leadTimeBands].map((items,i)=><div key={i}>{items.map((v:any)=><p key={v.name}>{v.name}：配对 {v.pairedSampleSize} 场；Brier差 {interval(v.brierInterval)}</p>)}</div>)}</details>
 <details className="experiment-detail-block"><summary>结果模式（原因未核验，不直接调参）</summary>{report.errors.summary.map(v=><p key={v.code}>{v.label} {v.count} 场 · {pct(v.rate)}</p>)}<p>次选命中不代表排序错误；未进入TopK不证明尾部偏窄；需要独立、批量概率验证。</p></details>
 {report.rollback.triggered&&<p className="rollback-alert">近期配对Brier劣于基线 {number(report.rollback.recentDelta)}，提示人工核查，不自动重写预测。</p>}
 <PredictionSlotComparison report={report.slotComparison}/>
 <TotalGoalsValidationPanel/>
 <ForwardValidationPanel/>
 </section>;
}
