"use client";
import {comparePurchaseSlots} from "../slot-comparison.js";
type Report=ReturnType<typeof comparePurchaseSlots>;
const signed=(value:number|null)=>value===null?"—":`${value>0?"+":""}¥${value.toFixed(2)}`;
const side=(value:Report["rows"][number]["early"])=>value.status!=="observed"?value.status==="missing"?"缺失":"多批，不能唯一配对":`${value.timing==="on-time"?"时点前完成":value.timing==="delayed"?"延迟批次":"时间未知"} · ${value.cash?.noTicket?"不投注":value.cash?.complete?"已结算":"待结算"}`;
export default function PurchaseSlotComparison({report}:{report:Report}){
  return <details className="purchase-history-panel"><summary><strong>17点 / 21点批次对照</strong><span>时点内配对 {report.strictDays} 日 · 延迟配对 {report.delayedDays} 日</span></summary>
    <p className="purchase-risk">同一销售日、同一策略与模型版本才配对；手动例外、缺失和待结算不计输。两批次选场可能不同，现金结果不代表预测准确度；延迟批次不能当作严格17点或21点决策。</p>
    <div className="purchase-history-scroll"><table><thead><tr><th>销售日</th><th>17点执行</th><th>17点净收益</th><th>21点执行</th><th>21点净收益</th><th>配对状态</th></tr></thead><tbody>
      {report.rows.length?report.rows.map(row=><tr key={row.date}><td>{row.date}</td><td>{side(row.early)}{row.early.actualAt&&<small>实际 {new Date(row.early.actualAt).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai",hour:"2-digit",minute:"2-digit"})}</small>}</td><td className={(row.early.cash?.net||0)>0?"purchase-money-positive":(row.early.cash?.net||0)<0?"purchase-money-negative":""}>{signed(row.early.cash?.net??null)}</td><td>{side(row.late)}{row.late.actualAt&&<small>实际 {new Date(row.late.actualAt).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai",hour:"2-digit",minute:"2-digit"})}</small>}</td><td className={(row.late.cash?.net||0)>0?"purchase-money-positive":(row.late.cash?.net||0)<0?"purchase-money-negative":""}>{signed(row.late.cash?.net??null)}</td><td>{row.paired?row.timing==="strict"?"严格时点配对":"延迟批次配对":row.reason}{row.strategyPairs.length>0&&<details><summary>同类型已结算票 {row.strategyPairs.length} 组</summary>{row.strategyPairs.map((pair:{definitionId:string;earlyNet:number;lateNet:number})=><p key={pair.definitionId}>{pair.definitionId}：17点 {signed(pair.earlyNet)} / 21点 {signed(pair.lateNet)}</p>)}</details>}</td></tr>):<tr><td colSpan={6}>尚无可核验的批次记录</td></tr>}
    </tbody></table></div>
  </details>;
}
