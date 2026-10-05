"use client";
import { useMemo, useState } from "react";
import data from "../../data/screenshot-research-2026-10-05.json";
import styles from "./ScreenshotPredictionReport.module.css";
const pct = (value: number) => `${value.toFixed(1)}%`;
type Candidate = { id: string; home: string; away: string; picks: { label: string; probability: number }[]; coverage: number };
export default function ScreenshotRecommendations() {
  const [market,setMarket] = useState("goals");
  const [count,setCount] = useState(2);
  const plans = useMemo(() => {
    const candidates: Candidate[] = data.matches.map(m => {
      const picks = market === "goals" ? m.picks.map(p => ({label:`${p.goals===7?"7+":p.goals}球`,probability:p.probability})) : m.scores.slice(0,2).map(p=>({label:p.score,probability:p.probability}));
      return {id:m.id,home:m.home,away:m.away,picks,coverage:picks.reduce((sum,p)=>sum+p.probability,0)};
    });
    const combinations: {matches: Candidate[]; probability: number}[] = [];
    const visit = (start: number, selected: Candidate[]) => {
      if(selected.length === count) {combinations.push({matches:selected,probability:100*selected.reduce((p,m)=>p*m.coverage/100,1)});return;}
      for(let i=start;i<=candidates.length-(count-selected.length);i++) visit(i+1,[...selected,candidates[i]]);
    };
    visit(0,[]);
    return combinations.sort((a,b)=>b.probability-a.probability || a.matches.map(m=>m.id).join().localeCompare(b.matches.map(m=>m.id).join())).slice(0,3);
  },[market,count]);
  return <section className={styles.report} aria-label="截图研究推荐">
    <header><span className={styles.tag}>截图数据 · 7场候选</span><h2>今日推荐：截图研究方案</h2>
      <p>使用已录入的三家公司截图赔率模型，遍历场次组合，按整组覆盖概率排序。截图日期为{data.sourceDateText}，尚未核验为今日竞彩销售场次。</p></header>
    <div className={styles.controls}>
      <label>预测类型<select value={market} onChange={e=>setMarket(e.target.value)}><option value="goals">总进球双选</option><option value="scores">比分双选</option></select></label>
      <label>组合场数<select value={count} onChange={e=>setCount(Number(e.target.value))}>{Array.from({length:7},(_,i)=><option key={i+1} value={i+1}>{i+1}场</option>)}</select></label>
    </div>
    <p className={styles.note}>联合概率按各场独立假设计算；表示每场所选两个结果中至少一个命中、且整组全部场次命中。相关性和模型误差尚未校正。</p>
    <div className={styles.cards}>{plans.map((plan,i)=><article className={styles.card} key={plan.matches.map(m=>m.id).join()}>
      <h3>方案{i+1} · {count}场{market==="goals"?"总进球":"比分"}双选</h3>
      <div className={styles.pick}><strong>整组覆盖概率 {pct(plan.probability)}</strong><span>至少一场未覆盖 {pct(100-plan.probability)}</span></div>
      {plan.matches.map(m=><div key={m.id} className={styles.company}><strong>{m.home} — {m.away}</strong><p>{m.picks.map(p=>`${p.label} ${pct(p.probability)}`).join(" / ")}<br/>单场覆盖 {pct(m.coverage)}</p></div>)}
      <p>展开组合：{2**count}种结果组合</p>
      <p className={styles.note}>模型预期返奖：暂不可计算。截图未提供体彩对应选项赔率，无法按整套购买组合计算返奖、成本与净收益。</p>
    </article>)}</div>
    <p className={styles.note}>截图研究方案独立展示，不加入正式推荐、固定票或历史返奖统计。伤停、首发与近期表现尚未补充。</p>
  </section>;
}
