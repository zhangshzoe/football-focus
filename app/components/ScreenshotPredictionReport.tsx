import data from "../../data/screenshot-research-2026-10-05.json";
import styles from "./ScreenshotPredictionReport.module.css";
const pct = (value: number) => `${value.toFixed(1)}%`;
export default function ScreenshotPredictionReport({ market = false }: { market?: boolean }) {
  const largestRisk = [...data.matches].sort((a,b) => a.coverage-b.coverage)[0];
  return <section className={styles.report} aria-label="截图研究预测">
    <header><span className={styles.tag}>截图录入 · 7场</span><h2>{market ? "截图盘口预测" : "截图研究预测"}</h2>
      <p>来源：中国足彩网，36、SB、平三家即时赔率。截图赛事日期为{data.sourceDateText}，赔率更新时间未知。录入日期：2026-10-05。</p>
      <p>{data.methodology}。以下为固定截图的模型估计，未核验为今日竞彩场次，不参与正式推荐和返奖统计。</p>
    </header>
    <p className={styles.risk}>按总进球双选未覆盖概率排序，{largestRisk.home}—{largestRisk.away}风险最高：{pct(100-largestRisk.coverage)}。</p>
    <div className={styles.cards}>{data.matches.map(match => <article className={styles.card} key={match.id}>
      <h3>{match.home}<span> vs </span>{match.away}</h3>
      <div className={styles.had}>{["主胜","平局","客胜"].map((label,i) => <div key={label}><span>{label}</span><strong>{pct(match.had[i])}</strong></div>)}</div>
      <div className={styles.pick}><strong>总进球双选：{[...match.picks].sort((a,b)=>a.goals-b.goals).map(p=>`${p.goals===7?"7+":p.goals}球`).join(" / ")}</strong>
        <span>覆盖 {pct(match.coverage)} · 未覆盖 {pct(100-match.coverage)}</span></div>
      {market && <div className={styles.market}><strong>{match.marketAnalysis.direction}</strong><p>{match.marketAnalysis.summary}</p>
        <details><summary>查看三家公司变盘与结算概率</summary>
          {match.marketAnalysis.companies.map(c => <div key={c.name} className={styles.company}>
            <h4>{c.name} · 初盘 → 即时盘</h4>
            <p>主队让球：{c.opening.handicap} → {c.current.handicap}<br/>大小球：{c.opening.total} → {c.current.total}<br/>欧赔：{[c.opening.win,c.opening.draw,c.opening.lose].join(" / ")} → {[c.current.win,c.current.draw,c.current.lose].join(" / ")}</p>
            {[["主队盘口",c.homeSettlement],["客队盘口",c.awaySettlement],["大球",c.overSettlement],["小球",c.underSettlement]].map(([label,value]) => {
              const s = value as typeof c.homeSettlement;
              return <p key={String(label)}><strong>{String(label)}</strong>：全赢{pct(s.fullWin)} · 半赢{pct(s.halfWin)} · 走盘{pct(s.push)} · 半输{pct(s.halfLoss)} · 全输{pct(s.fullLoss)}</p>;
            })}
          </div>)}
          <p className={styles.note}>让球数均以主队为基准，负数为主让、正数为主受让。结算概率按对应公司的即时盘口计算；半赢、半输表示一半本金走盘。变盘方向表示相对变化，不等于赛果概率最高方向。</p>
        </details>
      </div>}
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
