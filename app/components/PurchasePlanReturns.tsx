"use client";

import type { PurchaseItem } from "./TodayRecommendations";
import { calculateRecommendationReturns, type RecommendationMarket } from "../recommendation-returns";

export function SignedPurchaseMoney({value,flow="net"}:{value:number;flow?:"net"|"stake"|"return"}){
  const amount=Number.isFinite(value)?value:0;
  const signed=flow==="stake"?-Math.abs(amount):flow==="return"?Math.abs(amount):amount;
  return <b className={`purchase-money ${signed<0?"purchase-money-negative":signed>0?"purchase-money-positive":""}`}>{signed<0?"-":signed>0?"+":""}¥{Math.abs(signed).toFixed(2)}</b>;
}

export default function PurchasePlanReturns({plan}:{plan:{items:PurchaseItem[]}}){
  let returns;
  try {
    returns=calculateRecommendationReturns(plan.items.map(item=>({
      matchKey:item.officialMatchId||`${item.salesDate||item.matchDate||""}:${item.matchId}`,
      market:item.market as RecommendationMarket,
      scores:(item.picks?.length?item.picks:[item]).map(pick=>({score:pick.pick,probability:pick.probability,odd:pick.odd})),
    })));
  } catch {
    return <span className="purchase-leg-returns">本组合返奖：数据待补</span>;
  }
  if(returns.status!=="ready")return <span className="purchase-leg-returns">本组合返奖：赔率待补</span>;
  return <span className="purchase-leg-returns">
    <span>本组合模型预期返奖 {returns.expectedReturn===null?"概率待补":`¥${returns.expectedReturn.toFixed(2)}`}</span>
    <span>组合命中返奖 ¥{returns.minWinningReturn.toFixed(2)}～¥{returns.maxWinningReturn.toFixed(2)}</span>
    <span>命中时最低 / 最高盈利 <SignedPurchaseMoney value={returns.minWinningProfit}/> / <SignedPurchaseMoney value={returns.maxWinningProfit}/></span>
  </span>;
}
