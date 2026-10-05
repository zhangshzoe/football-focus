import data from "../../data/screenshot-research-2026-10-05.json";
import styles from "./ScreenshotPredictionReport.module.css";
const pct = (value: number) => `${value.toFixed(1)}%`;
export default function ScreenshotPredictionReport() {
  const largestRisk = [...data.matches].sort((a,b) => a.coverage-b.coverage)[0];
  return <section className={styles.report} aria-label="截图研究预测">
    <header><span className={styles.tag}>截图录入 · 7场</span><h2>截图研究预测</h2>
      <p>来源：中国足彩网，36、SB、平三家即时赔率。截图赛事日期为{data.sourceDateText}，赔率更新时间未知。录入日期：2026-10-05。</p>
      <p>{data.methodology}。以下为固定截图的模型估计，未核验为今日竞彩场次，不参与正式推荐和返奖统计。</p>
    </header>
    <p className={styles.risk}>按总进球双选未覆盖概率排序，{largestRisk.home}—{largestRisk.away}风险最高：{pct(100-largestRisk.coverage)}。</p>
    <div className={styles.cards}>{data.matches.map(match => <article className={styles.card} key={match.id}>
      <h3>{match.home}<span> vs </span>{match.away}</h3>
      <div className={styles.had}>{["主胜","平局","客胜"].map((label,i) => <div key={label}><span>{label}</span><strong>{pct(match.had[i])}</strong></div>)}</div>
      <div className={styles.pick}><strong>总进球双选：{[...match.picks].sort((a,b)=>a.goals-b.goals).map(p=>`${p.goals===7?"7+":p.goals}球`).join(" / ")}</strong>
        <span>覆盖 {pct(match.coverage)} · 未覆盖 {pct(100-match.coverage)}</span></div>
      <details><summary>查看比分、进球分布与大小球</summary>
        <h4>前四个比分</h4><div className={styles.scores}>{match.scores.map(p=><div key={p.score}><strong>{p.score}</strong><span>{pct(p.probability)}</span></div>)}</div>
        <h4>总进球完整分布</h4><div className={styles.goals}>{match.totalGoalProbabilities.map((p,i)=><div key={i}><span>{i===7?"7+":i}球</span><strong>{pct(p)}</strong></div>)}</div>
        <h4>统一2.5球比较</h4><p>小2.5球（0–2球）：{pct(match.under25)}<br/>大2.5球（3球以上）：{pct(match.over25)}</p>
        <h4>3球盘口结算概率</h4><p>0–2球：{pct(match.under3)} · 恰好3球（走盘）：{pct(match.push3)} · 4球以上：{pct(match.over3)}</p>
        <p className={styles.note}>截图中的实际大小球盘口可能为2、2.25、2.75、3或3.25球；与上面的统一2.5球比较口径不同。比分概率使用完整分布，前四项不会重新归一化。</p>
      </details>
    </article>)}</div>
  </section>;
}
