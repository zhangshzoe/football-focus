import {settleTicket, moneyCents, ticketFixtureKey, ticketPickLabel, validateTicketLegs, TICKET_SETTLEMENT_VERSION} from "./ticket-economics.js";

// Bounded research prototype. All tickets use ONE supplied assessment basis.
// Frozen ticket prices, selections and handicaps are never changed.
export const PORTFOLIO_SCENARIO_VERSION = "shared-fixture-score-events-research-v1";
export const EXACT_SCORE_LABELS = Object.freeze(Array.from({length:169}, (_,i) => `${Math.floor(i/13)}:${i%13}`));
export const OFFICIAL_SCORE_LABELS = Object.freeze(["1:0","2:0","2:1","3:0","3:1","3:2","4:0","4:1","4:2","5:0","5:1","5:2","胜其他","0:0","1:1","2:2","3:3","平其他","0:1","0:2","1:2","0:3","1:3","2:3","0:4","1:4","2:4","0:5","1:5","2:5","负其他"]);
const SCORE_SET = new Set(OFFICIAL_SCORE_LABELS);
const MARKET_ALIASES = Object.freeze({score:"score",比分:"score",had:"had",胜平负:"had",hhad:"hhad",让球胜平负:"hhad",total:"total",总进球数:"total",halfFull:"halfFull",半全场:"halfFull"});
const MARKET_LABELS = {score:SCORE_SET, had:new Set(["胜","平","负"]), hhad:new Set(["让胜","让平","让负"]), total:new Set(["0球","1球","2球","3球","4球","5球","6球","7+球"])};
const ASSUMPTIONS = Object.freeze({crossFixture:"assumed-independent", withinFixture:"one-score-event-shared-by-all-tickets", futureVoids:"not-modeled", scoreSupport:"0-12-goals-per-team-renormalized-model-grid", expectation:"linearity-does-not-imply-independent-ticket-hits"});
const unavailableMetrics = Object.freeze({expectedProfit:null, expectedReturn:null, profitProbability:null, lossProbability:null, zeroReturnProbability:null, anyWinningTicketProbability:null, allWinningTicketProbability:null, netProfitQuantiles:null, worstFivePercentMeanProfit:null, minimumScenarioProfit:null, maximumScenarioProfit:null});
class RiskInputError extends Error {constructor(code, details={}) {super(code); this.code=code; this.details=details;}}
const fail = (code,details) => {throw new RiskInputError(code,details);};
const selections = leg => leg.scores || leg.picks || [leg];
const safeIntegerCents = (value, code, details) => {const cents=moneyCents(value); if(cents===null) fail(code,details); return cents;};
const asMoney = cents => Number(cents)/100;
const compareText = (a,b) => a<b ? -1 : a>b ? 1 : 0;
const zonedInstant = value => {
  if(typeof value!=="string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  const [year,month,day,hour,minute,second]=value.match(/^\d{4}|\d{2}/g).slice(0,6).map(Number);
  return month>=1&&month<=12&&day>=1&&day<=new Date(Date.UTC(year,month,0)).getUTCDate()&&hour<=23&&minute<=59&&second<=59&&Number.isFinite(Date.parse(value));
};

/** Full 169-point validation; no top-score reconstruction or invented mass. */
export function validateFixtureScoreDistribution(points) {
  if(!Array.isArray(points) || points.length!==169) fail("score_distribution_incomplete");
  const byScore=new Map();
  for(const point of points) {
    const label=ticketPickLabel({pick:point?.score}), probability=point?.probability;
    if(!EXACT_SCORE_LABELS.includes(label) || byScore.has(label) || typeof probability!=="number" || !Number.isFinite(probability) || probability<0 || probability>100) fail("score_distribution_invalid",{score:label});
    byScore.set(label,probability);
  }
  const sourceTotalPercent=EXACT_SCORE_LABELS.reduce((sum,label)=>sum+byScore.get(label),0);
  if(!(sourceTotalPercent>0) || Math.abs(sourceTotalPercent-100)>.5) fail("score_distribution_mass_invalid",{sourceTotalPercent});
  return {sourceTotalPercent, normalizationApplied:Math.abs(sourceTotalPercent-100)>1e-10,
    points:EXACT_SCORE_LABELS.map(score=>({score,probability:byScore.get(score)/sourceTotalPercent}))};
}

/** The same score event can yield different frozen HHAD results for different tickets. */
export function deriveScenarioMarketOutcome({homeGoals,awayGoals},market,handicap) {
  if(!Number.isInteger(homeGoals)||!Number.isInteger(awayGoals)||homeGoals<0||awayGoals<0) fail("score_event_invalid");
  const normalized=MARKET_ALIASES[market];
  const result=homeGoals>awayGoals ? "胜" : homeGoals===awayGoals ? "平" : "负";
  if(normalized==="had") return result;
  if(normalized==="score") {const score=`${homeGoals}:${awayGoals}`; return SCORE_SET.has(score) ? score : `${result}其他`;}
  if(normalized==="total") return homeGoals+awayGoals>=7 ? "7+球" : `${homeGoals+awayGoals}球`;
  if(normalized==="hhad") {
    if(!["number","string"].includes(typeof handicap) || typeof handicap==="string"&&!/^[+-]?\d+(?:\.0+)?$/.test(handicap.trim()) || !Number.isSafeInteger(Number(handicap))) fail("handicap_invalid");
    const adjusted=homeGoals-awayGoals+Number(handicap);
    return adjusted>0 ? "让胜" : adjusted===0 ? "让平" : "让负";
  }
  fail(normalized==="halfFull" ? "half_full_unavailable" : "market_unavailable",{market});
}

function fingerprintTicket(plan) {
  return JSON.stringify({stake:plan.stake??null,items:plan.items.map(leg=>({fixture:ticketFixtureKey(leg),market:MARKET_ALIASES[leg.market],handicap:leg.handicap??null,picks:selections(leg).map(p=>[ticketPickLabel(p),p.odd,p.probability??null]).sort((a,b)=>compareText(a[0],b[0]))})).sort((a,b)=>compareText(a.fixture,b.fixture))});
}
function validateOptions(options) {
  const {sampleCount,maxExactStates,maxTickets,maxFixtures,maxExpandedBetsPerTicket}=options;
  for(const [key,value,maximum] of [["sampleCount",sampleCount,200000],["maxExactStates",maxExactStates,200000],["maxTickets",maxTickets,100],["maxFixtures",maxFixtures,64],["maxExpandedBetsPerTicket",maxExpandedBetsPerTicket,32768]]) if(!Number.isSafeInteger(value)||value<1||value>maximum) fail("bounds_invalid",{key});
  if(!["auto","exact","sample"].includes(options.method)) fail("method_invalid");
  if(typeof options.basisPredictionId!=="string"||!options.basisPredictionId.trim()) fail("assessment_basis_missing");
  if(!zonedInstant(options.assessmentAt)) fail("assessment_time_invalid");
  if(!["string","number"].includes(typeof options.seed)||!String(options.seed).length||String(options.seed).length>200||typeof options.seed==="number"&&!Number.isFinite(options.seed)) fail("seed_invalid");
}
function compile(options) {
  if(!Array.isArray(options.plans)||!Array.isArray(options.priorPlans)||!Array.isArray(options.fixtureForecasts)||!Array.isArray(options.knownVoidFixtureKeys)) fail("input_invalid");
  const evidence=new Map(), tickets=[], voidKeys=new Set(options.knownVoidFixtureKeys);
  let duplicateEvidenceCount=0;
  const input=[...options.priorPlans.map(plan=>({plan,role:"prior"})),...options.plans.map(plan=>({plan,role:"current"}))];
  for(const {plan,role} of input) {
    if(!plan || typeof plan!=="object") fail("ticket_invalid",{role});
    if(plan.status==="unavailable") continue;
    if(!Array.isArray(plan.items)||!plan.items.length) fail("ticket_items_missing",{id:plan.id,role});
    const id=String(plan.originPlanId||plan.id||"");
    const batchId=String(role==="prior" ? plan.priorBatchId||plan.batchId||"" : plan.batchId||options.currentBatchId);
    if(!id||!batchId) fail("ticket_identity_missing",{id,role});
    try {validateTicketLegs(plan.items);} catch(error) {fail("ticket_invalid",{id,message:error.message});}
    let betCount=1;
    for(const leg of plan.items) {
      const fixtureKey=ticketFixtureKey(leg), market=MARKET_ALIASES[leg.market];
      if(!fixtureKey) fail("fixture_identity_missing",{id});
      if(market==="halfFull") fail("half_full_unavailable",{id,fixtureKey});
      if(!MARKET_LABELS[market]) fail("market_unavailable",{id,market:leg.market});
      if(market==="hhad") deriveScenarioMarketOutcome({homeGoals:0,awayGoals:0},market,leg.handicap);
      for(const pick of selections(leg)) {
        if(!MARKET_LABELS[market].has(ticketPickLabel(pick))) fail("ticket_pick_invalid",{id,fixtureKey,pick:ticketPickLabel(pick)});
        if(!voidKeys.has(fixtureKey)&&(typeof pick.odd!=="number"||!Number.isFinite(pick.odd)||pick.odd<=1)) fail("frozen_odd_invalid",{id,fixtureKey});
      }
      betCount*=selections(leg).length;
      if(!Number.isSafeInteger(betCount)||betCount>options.maxExpandedBetsPerTicket) fail("expanded_bet_bound_exceeded",{id});
    }
    const stakeCents=safeIntegerCents(betCount*2,"stake_invalid",{id});
    if(role==="prior" && plan.stake===undefined) fail("prior_stake_missing",{id,batchId});
    if(plan.stake!==undefined&&safeIntegerCents(plan.stake,"stake_invalid",{id})!==stakeCents) fail("frozen_stake_mismatch",{id,batchId});
    const identity=JSON.stringify([batchId,id]), fingerprint=fingerprintTicket(plan), previous=evidence.get(identity);
    if(previous) {if(previous!==fingerprint) fail("ticket_evidence_conflict",{id,batchId}); duplicateEvidenceCount++; continue;}
    evidence.set(identity,fingerprint); tickets.push({id,batchId,identity,role,items:plan.items,stakeCents,betCount,cache:new Map()});
  }
  tickets.sort((a,b)=>compareText(a.identity,b.identity));
  if(tickets.length>options.maxTickets) fail("ticket_bound_exceeded");
  const fixtures=new Map(), officialKeys=new Map();
  for(const ticket of tickets) {
    ticket.refs=ticket.items.map((leg,legIndex)=>{
      const key=ticketFixtureKey(leg), officialId=String(leg.officialMatchId||"");
      if(officialId&&officialKeys.has(officialId)&&officialKeys.get(officialId)!==key) fail("fixture_identity_conflict",{officialMatchId:officialId});
      if(officialId) officialKeys.set(officialId,key);
      if(!fixtures.has(key)) fixtures.set(key,{key,occurrences:[]});
      const fixture=fixtures.get(key), offset=fixture.occurrences.length;
      fixture.occurrences.push({market:leg.market,handicap:leg.handicap});
      return {key,offset,legIndex};
    });
  }
  if(fixtures.size>options.maxFixtures) fail("fixture_bound_exceeded");
  for(const key of voidKeys) if(!fixtures.has(key)) fail("void_fixture_not_in_portfolio",{fixtureKey:key});
  const forecasts=new Map();
  for(const forecast of options.fixtureForecasts) {
    if(!forecast || typeof forecast!=="object") fail("fixture_forecast_invalid");
    const key=ticketFixtureKey(forecast);
    if(!key||!fixtures.has(key)) continue;
    if(forecast.predictionId!==options.basisPredictionId) fail("assessment_basis_conflict",{fixtureKey:key,predictionId:forecast.predictionId??null});
    if(!forecast.predictionGeneratedAt) fail("assessment_basis_time_missing",{fixtureKey:key});
    if(!zonedInstant(forecast.predictionGeneratedAt)) fail("assessment_basis_time_invalid",{fixtureKey:key});
    if(Date.parse(forecast.predictionGeneratedAt)>Date.parse(options.assessmentAt)) fail("assessment_basis_from_future",{fixtureKey:key});
    let validated;
    try {validated=validateFixtureScoreDistribution(forecast.fullScoreDistribution);} catch(error) {if(error instanceof RiskInputError) error.details={...error.details,fixtureKey:key}; throw error;}
    const signature=JSON.stringify(validated.points);
    if(forecasts.has(key)&&forecasts.get(key).signature!==signature) fail("fixture_distribution_conflict",{fixtureKey:key});
    forecasts.set(key,{...validated,signature});
  }
  const missing=[...fixtures.keys()].filter(key=>!voidKeys.has(key)&&!forecasts.has(key));
  if(missing.length) fail("assessment_basis_incomplete",{missingFixtures:missing.sort(compareText)});
  const sortedFixtures=[...fixtures.values()].sort((a,b)=>compareText(a.key,b.key));
  for(const fixture of sortedFixtures) {
    if(voidKeys.has(fixture.key)) {fixture.states=[{weight:1,void:true,outcomes:fixture.occurrences.map(()=>null)}]; continue;}
    const forecast=forecasts.get(fixture.key), groups=new Map();
    fixture.sourceTotalPercent=forecast.sourceTotalPercent; fixture.normalizationApplied=forecast.normalizationApplied;
    for(const point of forecast.points) {
      if(point.probability===0) continue;
      const [homeGoals,awayGoals]=point.score.split(":").map(Number);
      const outcomes=fixture.occurrences.map(leg=>deriveScenarioMarketOutcome({homeGoals,awayGoals},leg.market,leg.handicap));
      const signature=JSON.stringify(outcomes), previous=groups.get(signature);
      if(previous) previous.weight+=point.probability; else groups.set(signature,{weight:point.probability,void:false,outcomes});
    }
    fixture.states=[...groups.values()];
    let cumulative=0; fixture.cdf=fixture.states.map(state=>(cumulative+=state.weight)); fixture.cdf[fixture.cdf.length-1]=1;
  }
  const totalStakeCents=tickets.reduce((sum,ticket)=>sum+ticket.stakeCents,0n);
  if(totalStakeCents>BigInt(Number.MAX_SAFE_INTEGER)) fail("cash_precision_bound_exceeded");
  return {tickets,fixtures:sortedFixtures,totalStakeCents,duplicateEvidenceCount};
}

// Stable seeded PRNG, numerical score order and canonical fixture/ticket order.
function seededRandom(seed) {
  let state=2166136261;
  for(const char of String(seed)) state=Math.imul(state^char.charCodeAt(0),16777619)>>>0;
  return () => {state=(state+0x6D2B79F5)>>>0; let t=Math.imul(state^(state>>>15),state|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296;};
}
function settleScenario(compiled,states) {
  let returnedCents=0n, anyWin=false, allWin=true;
  for(const ticket of compiled.tickets) {
    const events=ticket.refs.map(ref=>({state:states.get(ref.key),offset:ref.offset}));
    const signature=JSON.stringify(events.map(({state,offset})=>state.void ? ["void"] : [state.outcomes[offset]]));
    let cash=ticket.cache.get(signature);
    if(!cash) {
      const items=ticket.items.map((leg,index)=>{const {state,offset}=events[index];return {...leg,actual:state.void?undefined:state.outcomes[offset],settlementState:state.void?"void_settled":"settled"};});
      const result=settleTicket(items);
      if(result.status==="pending"||result.totalStake*100!==Number(ticket.stakeCents)) fail("scenario_settlement_invalid",{id:ticket.id});
      cash={returnedCents:safeIntegerCents(result.returned,"cash_precision_bound_exceeded",{id:ticket.id}),won:result.status==="won"};
      ticket.cache.set(signature,cash);
    }
    returnedCents+=cash.returnedCents; anyWin ||= cash.won; allWin &&= cash.won;
  }
  if(returnedCents>BigInt(Number.MAX_SAFE_INTEGER)) fail("cash_precision_bound_exceeded");
  return {returnedCents,netCents:returnedCents-compiled.totalStakeCents,anyWin,allWin};
}
function summarize(rows) {
  const mass=rows.reduce((sum,row)=>sum+row.weight,0), distribution=new Map();
  let expectedProfit=0, expectedReturn=0, profitProbability=0, lossProbability=0, zeroReturnProbability=0, anyWinningTicketProbability=0, allWinningTicketProbability=0;
  for(const row of rows) {
    const weight=row.weight/mass, key=String(row.netCents);
    distribution.set(key,(distribution.get(key)||0)+weight);
    expectedProfit+=asMoney(row.netCents)*weight;
    expectedReturn+=asMoney(row.returnedCents)*weight;
    if(row.netCents<0n) lossProbability+=weight;
    if(row.netCents>0n) profitProbability+=weight;
    if(row.returnedCents===0n) zeroReturnProbability+=weight;
    if(row.anyWin) anyWinningTicketProbability+=weight;
    if(row.allWin) allWinningTicketProbability+=weight;
  }
  const sorted=[...distribution].map(([key,weight])=>({cents:BigInt(key),weight})).sort((a,b)=>a.cents<b.cents?-1:a.cents>b.cents?1:0);
  const quantile=probability=>{let cumulative=0;for(const row of sorted) {cumulative+=row.weight;if(cumulative+1e-12>=probability) return asMoney(row.cents);}return asMoney(sorted.at(-1).cents);};
  let remaining=.05, tailTotal=0;
  for(const row of sorted) {const weight=Math.min(remaining,row.weight);tailTotal+=asMoney(row.cents)*weight;remaining-=weight;if(remaining<=1e-15) break;}
  const bounded=p=>Math.min(1,Math.max(0,p));
  return {expectedProfit,expectedReturn,profitProbability:bounded(profitProbability),lossProbability:bounded(lossProbability),zeroReturnProbability:bounded(zeroReturnProbability),anyWinningTicketProbability:bounded(anyWinningTicketProbability),allWinningTicketProbability:bounded(allWinningTicketProbability),netProfitQuantiles:{p05:quantile(.05),p50:quantile(.5),p95:quantile(.95)},worstFivePercentMeanProfit:tailTotal/.05,minimumScenarioProfit:asMoney(sorted[0].cents),maximumScenarioProfit:asMoney(sorted.at(-1).cents)};
}

/**
 * `fixtureForecasts`: reports with fixture identity, predictionId and COMPLETE
 * fullScoreDistribution. `priorPlans` require priorBatchId or batchId.
 * Evidence duplicates dedupe only within the same batch + origin plan identity;
 * separate real purchases across batches always retain their separate stakes.
 * knownVoidFixtureKeys are explicit deterministic assumptions, never sampled.
 * Input tickets/forecasts are read only. Returned values are research estimates.
 */
export function calculatePortfolioScenarioRisk(input={}) {
  const options={plans:[],priorPlans:[],fixtureForecasts:[],knownVoidFixtureKeys:[],currentBatchId:"current",method:"auto",sampleCount:10000,maxExactStates:50000,maxTickets:100,maxFixtures:64,maxExpandedBetsPerTicket:4096,seed:"football-portfolio-v1",...input};
  const metadata={version:PORTFOLIO_SCENARIO_VERSION,settlementVersion:TICKET_SETTLEMENT_VERSION,scope:options.priorPlans?.length?"day-with-verified-prior":"current-batch",basisPredictionId:options.basisPredictionId??null,assessmentAt:options.assessmentAt??null,assumptions:{...ASSUMPTIONS,knownVoidFixtureKeys:Array.isArray(options.knownVoidFixtureKeys)?[...options.knownVoidFixtureKeys].sort(compareText):[]},probabilityUnit:"fraction",isConfidenceInterval:false,crossFixtureCorrelationEstimated:false};
  try {
    validateOptions(options);
    const compiled=compile(options);
    if(!compiled.tickets.length) return {...metadata,status:"empty",totalStake:0,ticketCount:0,fixtureCount:0,...unavailableMetrics};
    const stateCount=compiled.fixtures.reduce((product,fixture)=>product*BigInt(fixture.states.length),1n), exact=options.method!=="sample"&&stateCount<=BigInt(options.maxExactStates);
    if(options.method==="exact"&&!exact) fail("exact_state_bound_exceeded",{compressedStateCount:String(stateCount)});
    const rows=[], states=new Map();
    if(exact) {
      const walk=(index,weight)=>{if(index===compiled.fixtures.length) {rows.push({...settleScenario(compiled,states),weight});return;}const fixture=compiled.fixtures[index];for(const state of fixture.states) {states.set(fixture.key,state);walk(index+1,weight*state.weight);}};
      walk(0,1);
    } else {
      const random=seededRandom(options.seed);
      for(let scenario=0;scenario<options.sampleCount;scenario++) {
        for(const fixture of compiled.fixtures) {const draw=random();let index=0;if(!fixture.states[0].void) while(index<fixture.cdf.length-1&&draw>=fixture.cdf[index]) index++;states.set(fixture.key,fixture.states[index]);}
        rows.push({...settleScenario(compiled,states),weight:1/options.sampleCount});
      }
    }
    return {...metadata,status:"ready",method:exact?"exact-shared-fixture-states":"seeded-score-sampling",seed:exact?null:String(options.seed),randomGenerator:exact?null:"mulberry32-fnv1a-v1",sampleCount:exact?null:options.sampleCount,scenarioCount:rows.length,compressedStateCount:String(stateCount),totalStake:asMoney(compiled.totalStakeCents),maximumLossBound:asMoney(compiled.totalStakeCents),ticketCount:compiled.tickets.length,fixtureCount:compiled.fixtures.length,duplicateEvidenceCount:compiled.duplicateEvidenceCount,tickets:compiled.tickets.map(({id,batchId,role,stakeCents})=>({id,batchId,role,stake:asMoney(stakeCents)})),fixtureBasis:compiled.fixtures.map(f=>({fixtureKey:f.key,stateCount:f.states.length,knownVoid:Boolean(f.states[0].void),sourceTotalPercent:f.sourceTotalPercent??null,normalizationApplied:f.normalizationApplied??false})),...summarize(rows)};
  } catch(error) {
    if(!(error instanceof RiskInputError)) throw error;
    return {...metadata,status:"unavailable",reason:error.code,details:error.details,totalStake:null,ticketCount:null,fixtureCount:null,...unavailableMetrics};
  }
}
