// Pure, shared by the Node snapshot job and the browser. Prices are frozen SP;
// probabilities are percentages. This is model-based arithmetic, not a promise.
const decimal = (value) => {
  const [whole, fraction = ""] = Number(value).toFixed(10).replace(/0+$/, "").replace(/\.$/, "").split(".");
  return {n: BigInt(whole + fraction), d: 10n ** BigInt(fraction.length)};
};
export const TICKET_SETTLEMENT_VERSION = "expanded-unit-bets-half-even-v2";
export function ticketFixtureKey(leg) {
  return leg.officialMatchId ? `${leg.salesDate || leg.matchDate || ""}|${leg.officialMatchId}` : leg.matchKey || (leg.matchId ? `${leg.salesDate || leg.matchDate || ""}|${leg.matchId}` : null);
}
const selections = leg => leg.scores || leg.picks || [leg];
export const ticketPickLabel = pick => String(pick.pick ?? pick.score ?? "").trim().replace(/\s/g, "").replace(/：/g, ":").replace(/^7(?:\+)?球$/, "7+球");
const pickLabel=ticketPickLabel;
export function validateTicketLegs(legs) {
  if (!Array.isArray(legs) || !legs.length || legs.length > 8) throw new Error("需要1–8场比赛");
  const identities = legs.map(ticketFixtureKey).filter(Boolean);
  if (new Set(identities).size !== identities.length) throw new Error("同一场比赛不能重复串关");
  const officialIds=legs.map(leg=>leg.officialMatchId&&String(leg.officialMatchId)).filter(Boolean);
  if(new Set(officialIds).size!==officialIds.length)throw new Error("同一官方比赛ID重复或销售日期冲突");
  for (const leg of legs) {
    const picks = selections(leg);
    if (!picks.length) throw new Error("投注选项为空");
    const labels = picks.map(pickLabel);
    if(labels.some(label=>!label))throw new Error("投注选项标签为空");
    if (new Set(labels).size !== labels.length) throw new Error("同场投注选项重复");
  }
}
const capFor = count => count === 1 ? 100000 : count <= 3 ? 200000 : count <= 5 ? 500000 : 1000000;
export const moneyCents = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round((value + Number.EPSILON) * 100)) ? BigInt(Math.round((value + Number.EPSILON) * 100)) : null;
function bonus(odds, cap) {
  const product = odds.map(decimal).reduce((a, b) => ({n:a.n*b.n,d:a.d*b.d}), {n:2n,d:1n});
  if (product.n >= BigInt(cap) * product.d) return cap;
  const thousandths = product.n * 1000n / product.d;
  let cents = thousandths / 10n;
  const digit = thousandths % 10n;
  if (digit > 5n || digit === 5n && cents % 2n === 1n) cents++;
  return Number(cents) / 100;
}
/** @returns {{status:'unavailable',unitStake:number,multiplier:number,betCount:number,totalStake:number,worstCaseProfit:number}|{status:'ready',unitStake:number,multiplier:number,betCount:number,totalStake:number,worstCaseProfit:number,bonusCap:number,expectedReturn:number|null,expectedProfit:number|null,expectedROI:number|null,minCombinedOdd:number,maxCombinedOdd:number,minWinningReturn:number,maxWinningReturn:number,minWinningProfit:number,maxWinningProfit:number,capped:boolean,probabilityAssumption:string}} */
export function calculateTicketEconomics(legs) {
  validateTicketLegs(legs);
  const picks = legs.map(leg => leg.scores || leg.picks || [leg]);
  if (picks.some(items => !items.length)) throw new Error("投注选项为空");
  const betCount = picks.reduce((n, items) => n * items.length, 1), totalStake = betCount * 2;
  if (picks.some(items => items.some(p => typeof p.odd !== "number" || !Number.isFinite(p.odd) || p.odd <= 1)))
    return {status:"unavailable",unitStake:2,multiplier:1,betCount,totalStake,worstCaseProfit:-totalStake};
  const bonusCap = capFor(legs.length);
  const minOdds = picks.map(items => Math.min(...items.map(p => p.odd))),maxOdds = picks.map(items => Math.max(...items.map(p => p.odd)));
  const minWinningReturn=bonus(minOdds,bonusCap),maxWinningReturn=bonus(maxOdds,bonusCap);
  const valid = picks.every(items => items.every(p => typeof p.probability === "number" && Number.isFinite(p.probability) && p.probability >= 0 && p.probability <= 100) && items.reduce((sum,p)=>sum+p.probability,0)<=100+1e-8);
  let expectedReturn = null;
  if (valid) {
    expectedReturn = 0;
    const walk = (index, odds, probability) => {
      if (index === picks.length) { expectedReturn += probability * bonus(odds,bonusCap); return; }
      for (const p of picks[index]) walk(index+1,[...odds,p.odd],probability*p.probability/100);
    };
    walk(0,[],1);
  }
  const expectedProfit=expectedReturn===null?null:expectedReturn-totalStake;
  return {status:"ready",unitStake:2,multiplier:1,betCount,totalStake,worstCaseProfit:-totalStake,bonusCap,expectedReturn,expectedProfit,expectedROI:expectedProfit===null?null:expectedProfit/totalStake,
    minCombinedOdd:minOdds.reduce((a,b)=>a*b,1),maxCombinedOdd:maxOdds.reduce((a,b)=>a*b,1),minWinningReturn,maxWinningReturn,
    minWinningProfit:minWinningReturn-totalStake,maxWinningProfit:maxWinningReturn-totalStake,capped:2*maxOdds.reduce((a,b)=>a*b,1)>bonusCap,probabilityAssumption:"independent-matches"};
}

/** Derived settlement; never mutates an immutable ticket. All void choices remain separate bets. */
export function settleTicket(legs) {
  validateTicketLegs(legs);
  const totalStake = selectionsCount(legs) * 2;
  const pending = legs.some(leg => leg.settlementState !== "void_settled" && (!leg.actual || leg.settlementState && !["settled", "corrected"].includes(leg.settlementState)));
  if (pending) return {status:"pending", totalStake, returned:null, version:TICKET_SETTLEMENT_VERSION};
  const allVoid = legs.every(leg => leg.settlementState === "void_settled");
  const winning = legs.map(leg => leg.settlementState === "void_settled" ? selections(leg).map(() => ({odd:1})) : selections(leg).filter(p => pickLabel(p) === pickLabel({pick:leg.actual})));
  if (winning.some(picks => !picks.length)) return {status:"lost",totalStake,returned:0,winningBets:0,version:TICKET_SETTLEMENT_VERSION};
  if (winning.some(picks => picks.some(p => typeof p.odd !== "number" || !Number.isFinite(p.odd) || p.odd < 1))) return {status:"pending",totalStake,returned:null,version:TICKET_SETTLEMENT_VERSION};
  let returnedCents=0n,winningBets=0;
  const walk=(index,odds)=>{if(index===winning.length){returnedCents+=moneyCents(bonus(odds,capFor(legs.length)));winningBets++;return;}for(const p of winning[index])walk(index+1,[...odds,p.odd]);};
  walk(0,[]);
  return {status:allVoid?"refund":"won",totalStake,returned:Number(returnedCents)/100,winningBets,version:TICKET_SETTLEMENT_VERSION};
}
const selectionsCount = legs => legs.reduce((count, leg) => count * selections(leg).length, 1);

/** Old records without per-leg outcomes keep their recorded cash result, explicitly labelled. */
export function settledTicketCash(plan) {
  if(!["won","lost","corrected_won","corrected_lost","void_won","void_lost","refunded"].includes(plan.status))return null;
  const stake=moneyCents(plan.stake);
  if (stake===null || stake===0n) return null;
  if(plan.items?.length && plan.items.every(leg => leg.settlementState==="void_settled" || leg.actual)) {
    try {
      const result=settleTicket(plan.items);
      if(result.status==="pending" || moneyCents(result.totalStake)!==stake)return null;
      return {stake,returned:moneyCents(result.returned),outcome:result.status==="refund"?"refund":result.status,version:result.version};
    }catch{return null;}
  }
  if(!["won","lost","corrected_won","corrected_lost","void_won","void_lost","refunded"].includes(plan.status))return null;
  if(plan.status==="refunded")return {stake,returned:stake,outcome:"refund",version:"legacy-recorded-cash-not-repriced"};
  const won=["won","corrected_won","void_won"].includes(plan.status),returned=won?moneyCents(plan.simulatedReturn):0n;
  return returned===null || won&&returned===0n ? null : {stake,returned,outcome:won?"won":"lost",version:"legacy-recorded-cash-not-repriced"};
}

export function ticketSensitivity(legs,relativeChange=0.1) {
  if (!Number.isFinite(relativeChange) || relativeChange < 0 || relativeChange > 0.5) throw new Error("敏感性参数无效");
  const scenario = factor => legs.map(leg => {
    const scores=leg.scores||leg.picks||[leg], q=scores.reduce((sum,p)=>sum+p.probability/100,0), denominator=1-q+factor*q;
    return {...leg,picks:undefined,scores:scores.map(p=>({...p,probability:typeof p.probability==="number"?p.probability*factor/denominator:null}))};
  });
  return {method:"selected-outcome-relative-weight",relativeChange,isConfidenceInterval:false,
    low:calculateTicketEconomics(scenario(1-relativeChange)),base:calculateTicketEconomics(legs),high:calculateTicketEconomics(scenario(1+relativeChange))};
}

export function summarizeTicketPortfolio(plans) {
  const valid=(plans||[]).filter(p=>p.status!=="unavailable"&&p.items?.length);
  const fixtureExposure=new Map(),leagueExposure=new Map(),keys=[],fixtureSets=[];
  let totalStake=0,expectedReturn=0,complete=true;
  for(const plan of valid){
    const economics=calculateTicketEconomics(plan.items),stake=economics.totalStake;
    totalStake+=stake;
    if(economics.expectedReturn===null||economics.expectedReturn===undefined)complete=false;else expectedReturn+=economics.expectedReturn;
    const fixtures=new Set(plan.items.map(ticketFixtureKey));
    const leagues=new Set(plan.items.map(item=>item.league||"未知联赛"));
    fixtures.forEach(key=>fixtureExposure.set(key,(fixtureExposure.get(key)||0)+stake));
    leagues.forEach(key=>leagueExposure.set(key,(leagueExposure.get(key)||0)+stake));
    fixtureSets.push(fixtures);
    keys.push(plan.items.map(item=>`${item.salesDate||""}|${item.officialMatchId||item.matchId}|${item.market}|${(item.scores||item.picks||[item]).map(p=>p.pick||p.score).sort().join("/")}`).sort().join(";"));
  }
  let overlappingPairs=0;
  for(let a=0;a<fixtureSets.length;a++)for(let b=a+1;b<fixtureSets.length;b++)if([...fixtureSets[a]].some(key=>fixtureSets[b].has(key)))overlappingPairs++;
  const exposure=(entries)=>[...entries].map(([key,stake])=>({key,stake,share:totalStake?stake/totalStake:0})).sort((a,b)=>b.stake-a.stake||a.key.localeCompare(b.key));
  return {scope:"if-all-purchased",tickets:valid.length,totalStake,maximumLossBound:totalStake,expectedReturn:complete?expectedReturn:null,expectedProfit:complete?expectedReturn-totalStake:null,
    expectedROI:complete&&totalStake?expectedReturn/totalStake-1:null,fixtures:exposure(fixtureExposure),leagues:exposure(leagueExposure),overlappingPairs,duplicateTickets:keys.length-new Set(keys).size,
    maxFixtureConcentration:totalStake?Math.max(0,...fixtureExposure.values())/totalStake:0,combinedHitProbability:null,correlationEstimated:false};
}
