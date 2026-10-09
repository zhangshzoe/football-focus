// Capture-only policy. Do not alter model probabilities or ticket selection.
export const WINDOW_MS = 15 * 60 * 1000;
export function captureWindow(now, scheduledAt, {purchase = false, preWindow = false} = {}) {
 const target = Date.parse(scheduledAt);
 if (!Number.isFinite(target)) throw new Error("计划时间无效");
 const start = target - (preWindow || !purchase ? WINDOW_MS : 0);
 const end = target + (purchase ? 100 * 60 * 1000 + 60000 : 1);
 return now < start ? "before-window" : now >= end ? "window-closed" : "eligible";
}
export function captureEvidence(scheduledAt, startedAt, capturedAt, completedAt, reports) {
 const target = Date.parse(scheduledAt), start = Date.parse(startedAt), complete = Date.parse(completedAt);
 const preMatch = reports.length > 0 && reports.every(row => Number.isFinite(Date.parse(row.kickoffAt)) && Date.parse(row.kickoffAt) > complete);
 const timely = start >= target - WINDOW_MS && start <= target && complete <= target && preMatch;
 return {scheduledAt, startedAt, capturedAt, completedAt, captureTiming:timely ? "on-time" : "delayed", decisionTiming:preMatch ? "pre_match" : "in_play", includedInStrictEvaluation:timely, includedInPreMatchEvaluation:timely};
}
export function assertOfficialInput(data, matches, now, {allowMissingCutoff=false}={}) {
 const fetched = Date.parse(data.fetchedAt);
 if (!Number.isFinite(fetched) || fetched > now + 60000 || now - fetched > 5 * 60000) throw new Error("官方数据采集时刻缺失或赔率过期");
 if (!matches.length) throw new Error("当日官方清单无可售场次，未生成快照");
 for (const match of matches) {
  if (!match.matchId || match.isMock || !Number.isFinite(Date.parse(match.kickoffAt)) || Date.parse(match.kickoffAt) <= now) throw new Error("官方身份无效或比赛已开赛");
  if (String(match.matchStatus).toLowerCase() !== "selling") throw new Error("官方比赛不在销售状态");
  const qualified = Object.values(match.marketEligibility || {}).some(m => m.qualification === "qualified" && String(m.salesStatus).toLowerCase() === "selling" && (Date.parse(m.cutoffAt) > now || (allowMissingCutoff && (m.cutoffAt==null||m.cutoffAt===""))));
  if (!qualified) {
   const markets=Object.values(match.marketEligibility||{}).filter(m=>m.qualification==="qualified"&&String(m.salesStatus).toLowerCase()==="selling");
   const error=new Error(`${match.id||match.matchId}：${markets.length?"官方停售时间缺失、无效或已到达":"没有合格且可售的官方玩法"}，拒绝正式留档`);
   error.code=markets.length?"OFFICIAL_CUTOFF_UNAVAILABLE":"OFFICIAL_MARKET_UNQUALIFIED";
   error.officialMatchId=String(match.officialMatchId||match.matchId);
   throw error;
  }
 }
}
export function selectSellingInputs(data,date,now){
 if(!Array.isArray(data.matches))throw new Error("官方清单未知，拒绝留档");
 const matches=[],excluded=[];
 for(const original of data.matches.filter(row=>row.salesDate===date)){
  const row={...original,marketEligibility:Object.fromEntries(Object.entries(original.marketEligibility||{}).map(([name,market])=>{
   const missing=market.cutoffAt==null||market.cutoffAt==="";
   const usable=missing||Date.parse(market.cutoffAt)>now;
   return [name,{...market,cutoffAt:missing?null:market.cutoffAt,cutoffStatus:missing?"unknown":"provided",qualification:usable?market.qualification:"not_selling"}];
  }))};
  try{assertOfficialInput(data,[row],now,{allowMissingCutoff:true});matches.push(row);}
  catch(error){excluded.push({id:row.id,officialMatchId:String(row.officialMatchId||row.matchId||""),reason:error.message,code:error.code||"OFFICIAL_INPUT_REJECTED"});}
 }
 return {matches,excluded};
}
export function changedOfficialOdds(left,right){
 return [...new Set([...Object.keys(left||{}),...Object.keys(right||{})])].filter(name=>JSON.stringify(left?.[name]??null)!==JSON.stringify(right?.[name]??null));
}
export function assertCoverage(matches, reports) {
 const ids = reports.map(r => String(r.officialMatchId));
 if (new Set(ids).size !== ids.length || matches.some(m => !ids.includes(String(m.officialMatchId || m.matchId)))) throw new Error("官方赛事预测评估不完整，拒绝部分成功留档");
}
export async function requestJson(url, options = {}) {
 const response = await fetch(url, {...options, signal:AbortSignal.timeout(120000)});
 let data;
 try { data = await response.json(); } catch { throw new Error("数据源返回非法 JSON"); }
 if (!response.ok) throw new Error(data.error || `数据读取失败（${response.status}）`);
 return data;
}
