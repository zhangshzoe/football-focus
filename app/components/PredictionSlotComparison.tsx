"use client";
import {comparePredictionSlots} from "../model-evaluation.js";

type Comparison = ReturnType<typeof comparePredictionSlots>;
const number = (value:number|null) => value === null ? "—" : value.toFixed(3);
const interval = (value:{delta:number|null;lower:number|null;upper:number|null;sampleSize:number;clusters:number}) =>
  value.delta === null ? "无配对样本" : value.lower === null
    ? `${number(value.delta)}（${value.sampleSize}场 / ${value.clusters}日，样本不足不报区间）`
    : `${number(value.delta)} [${number(value.lower)}, ${number(value.upper)}]`;
const names:Record<string,string> = {had:"胜平负",score:"完整比分",scoreOfficial:"体彩比分",hhad:"让球",total:"总进球",halfFull:"半全场（研究）"};

export default function PredictionSlotComparison({report}:{report:Comparison}) {
  const exclusions = report.excluded.reduce((counts:Record<string,number>,row)=>({...counts,[row.reason]:(counts[row.reason]||0)+1}),{});
  return <details className="experiment-detail-block purchase-history-panel">
    <summary><strong>17点 / 21点同场概率质量对照</strong><span>证据齐全的共同比赛 {report.commonFixtures} 场</span></summary>
    <p>比较两批全部预测的共同比赛，包括未入选票和不投注批次。只接受同场、同模型与校准版本、各自时点前15分钟内真实完成的记录。现金返奖在批次对照中另算。</p>
    {report.strata.map(stratum=><div key={stratum.version}><h4>版本 {stratum.version}</h4><div className="experiment-table-wrap"><table><thead><tr><th>玩法</th><th>同场样本</th><th>17点 Brier</th><th>21点 Brier</th><th>21−17 Brier差</th><th>Log Loss差</th><th>RPS差</th></tr></thead><tbody>{Object.entries(stratum.markets).map(([key,market])=><tr key={key}><td>{names[key]}</td><td>{market.sampleSize}</td><td>{number(market.early.brier)}</td><td>{number(market.late.brier)}</td><td>{interval(market.brierInterval)}</td><td>{interval(market.logLossInterval)}</td><td>{market.rpsInterval?interval(market.rpsInterval):"—"}</td></tr>)}</tbody></table></div></div>)}
    {!report.strata.length&&<p>暂无证据齐全的严格配对，不能认定21点更准确；不会用当前模型补造历史概率。</p>}
    <p>差值为21点减17点，负数较好；区间按销售日分块重采样，区间含0不声称领先。缺半场赛果只影响半全场；让球数改变的两批不作同一玩法配对。</p>
    <details><summary>排除原因（{report.excluded.length}条）</summary>{Object.entries(exclusions).map(([reason,count])=><p key={reason}>{reason}：{count}</p>)}</details>
  </details>;
}
