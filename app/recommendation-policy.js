import {calculateTicketEconomics,ticketFixtureKey,ticketPickLabel,ticketSensitivity,summarizeTicketPortfolio} from "./ticket-economics.js";

// Paper simulation limits, not a suggestion about anyone's real-money budget.
export const DEFAULT_RECOMMENDATION_POLICY=Object.freeze({version:"paper-risk-v3-probability",selectionMode:"probability-first",dailyBudget:100,maxFixtureStake:25,maxLeagueStake:50,maxTickets:5,maxSharedFixturesPerPair:1,maxTicketsPerFixture:2,minExpectedROI:0.05,stressChange:0.1});
export function normalizeRecommendationPolicy(input=DEFAULT_RECOMMENDATION_POLICY){
  const policy={...DEFAULT_RECOMMENDATION_POLICY,...input,version:DEFAULT_RECOMMENDATION_POLICY.version};
  if(!["probability-first","robust-ev"].includes(policy.selectionMode))throw new Error("推荐选择模式无效");
  for(const key of ["dailyBudget","maxFixtureStake","maxLeagueStake"]){if(typeof policy[key]!=="number"||!Number.isFinite(policy[key])||policy[key]<0||policy[key]>10000)throw new Error("模拟额度须在0–10000元之间");}
  if(!Number.isInteger(policy.maxTickets)||policy.maxTickets<0||policy.maxTickets>20)throw new Error("每日模拟票数须在0–20之间");
  if(!Number.isInteger(policy.maxSharedFixturesPerPair)||policy.maxSharedFixturesPerPair<0||policy.maxSharedFixturesPerPair>1||!Number.isInteger(policy.maxTicketsPerFixture)||policy.maxTicketsPerFixture<1||policy.maxTicketsPerFixture>20)throw new Error("共享场次与单场票数设置无效");
  if(!Number.isFinite(policy.minExpectedROI)||policy.minExpectedROI<0.05||policy.minExpectedROI>1||!Number.isFinite(policy.stressChange)||policy.stressChange<0.1||policy.stressChange>0.5)throw new Error("收益余量或压力检查设置无效");
  return policy;
}
export const RESEARCH_MARKETS=new Set(["halfFull","半全场"]);
export const REJECTION_LABELS={input_invalid:"身份或选项不完整",research_only:"半全场尚在研究阶段",non_positive_ev:"模型期望收益不为正",insufficient_margin:"模型收益余量不足",stress_failed:"概率下调后优势消失",duplicate_ticket:"与其他方式为同一张票",budget_limit:"超过每日模拟预算",fixture_limit:"同一比赛投入过于集中",league_limit:"同一联赛投入过于集中",ticket_limit:"达到每日模拟票数上限",shared_fixture_limit:"两张票共享场次过多",fixture_ticket_limit:"同一比赛进入的票数过多",prior_invalid:"早批次金额、身份或选项无法核验"};
export const canonicalTicketKey=items=>items.map(leg=>`${ticketFixtureKey(leg)}|${leg.market}|${(leg.picks||leg.scores||[leg]).map(ticketPickLabel).sort().join("/")}`).sort().join(";");
export function assessRecommendation(items,policy=DEFAULT_RECOMMENDATION_POLICY){
  try{
    policy=normalizeRecommendationPolicy(policy);
    if(!Array.isArray(items)||items.some(leg=>!ticketFixtureKey(leg)))return {eligible:false,reason:"input_invalid"};
    if(items.some(leg=>RESEARCH_MARKETS.has(leg.market)))return {eligible:false,reason:"research_only"};
    const economics=calculateTicketEconomics(items);
    if(economics.status!=="ready"||economics.expectedROI===null)return {eligible:false,reason:"input_invalid"};
    const sensitivity=ticketSensitivity(items,policy.stressChange);
    if(policy.selectionMode==="robust-ev"){
      if(economics.expectedROI<=0)return {eligible:false,reason:"non_positive_ev",economics};
      if(economics.expectedROI<policy.minExpectedROI)return {eligible:false,reason:"insufficient_margin",economics};
      if(sensitivity.low.status!=="ready"||sensitivity.low.expectedProfit===null||sensitivity.low.expectedProfit<0)return {eligible:false,reason:"stress_failed",economics,sensitivity};
    }
    return {eligible:true,economics,sensitivity};
  }catch{return {eligible:false,reason:"input_invalid"};}
}
export function selectRecommendationPortfolio(plans,{policy=DEFAULT_RECOMMENDATION_POLICY,priorPlans=/** @type {Array<object>} */([])}={}){
  policy=normalizeRecommendationPolicy(policy);
  const current=new Map();
  for(const plan of plans){const previous=current.get(plan.id);if(previous&&JSON.stringify([previous.items,previous.stake])!==JSON.stringify([plan.items,plan.stake]))return {plans:[...current.values(),plan].map(p=>({...p,status:"unavailable",items:[],rejectionCode:"input_invalid",reason:"当前类型ID对应多张不同票，拒绝重复计费"})),policy,priorState:"invalid",inputState:"invalid",selected:0,modelEligibleCount:0,portfolio:summarizeTicketPortfolio([])};if(!previous)current.set(plan.id,plan);}
  plans=[...current.values()];
  const fixture=new Map(),fixtureTickets=new Map(),fixtureSets=[],league=new Map(),seen=new Set(),priorSeen=new Map(),accepted=new Map(),decisions=new Map();
  let spent=0,count=0;
  const add=plan=>{const stake=calculateTicketEconomics(plan.items).totalStake;spent+=stake;count++;seen.add(canonicalTicketKey(plan.items));const fixtures=new Set(plan.items.map(ticketFixtureKey));fixtureSets.push(fixtures);for(const key of fixtures){fixture.set(key,(fixture.get(key)||0)+stake);fixtureTickets.set(key,(fixtureTickets.get(key)||0)+1);}for(const key of new Set(plan.items.map(i=>i.league||"未知联赛")))league.set(key,(league.get(key)||0)+stake);};
  for(const plan of priorPlans.filter(p=>p.status!=="unavailable")){try{
    if(!Array.isArray(plan.items)||!plan.items.length||plan.items.some(i=>!ticketFixtureKey(i)))throw new Error("早批次选项或身份缺失");
    const money=calculateTicketEconomics(plan.items);
    if(money.status!=="ready"||typeof plan.stake!=="number"||Math.abs(plan.stake-money.totalStake)>1e-8)throw new Error("早批次冻结投入不一致");
    const identity=`${plan.priorBatchId||"legacy"}|${plan.originPlanId||plan.id}|${canonicalTicketKey(plan.items)}`,fingerprint=JSON.stringify(plan.items);
    if(priorSeen.has(identity)){if(priorSeen.get(identity)!==fingerprint)throw new Error("早批次身份冲突");continue;}
    priorSeen.set(identity,fingerprint);add(plan);
  }catch{return {plans:plans.map(p=>({...p,status:"unavailable",items:[],rejectionCode:"prior_invalid",reason:REJECTION_LABELS.prior_invalid})),policy,priorState:"invalid",selected:0,modelEligibleCount:0,portfolio:summarizeTicketPortfolio([])};}}
  const priorStake=spent;
  const candidates=plans.filter(p=>p.status!=="unavailable"&&p.items?.length).flatMap(plan=>[plan,...(plan.candidateAlternatives||[]).map(alternative=>({...alternative,id:plan.id,title:plan.title,rule:plan.rule}))]).map(plan=>({plan,assessment:assessRecommendation(plan.items,policy)}));
  candidates.sort((a,b)=>policy.selectionMode==="probability-first"
    ? (b.plan.estimatedProbability??b.plan.items.reduce((p,i)=>p*(i.picks||[]).reduce((s,x)=>s+x.probability/100,0),1))-(a.plan.estimatedProbability??a.plan.items.reduce((p,i)=>p*(i.picks||[]).reduce((s,x)=>s+x.probability/100,0),1))||canonicalTicketKey(a.plan.items).localeCompare(canonicalTicketKey(b.plan.items))||a.plan.id.localeCompare(b.plan.id)
    : (b.assessment.sensitivity?.low.expectedROI??-Infinity)-(a.assessment.sensitivity?.low.expectedROI??-Infinity)||(b.assessment.economics?.expectedROI??-Infinity)-(a.assessment.economics?.expectedROI??-Infinity)||canonicalTicketKey(a.plan.items).localeCompare(canonicalTicketKey(b.plan.items))||a.plan.id.localeCompare(b.plan.id));
  for(const {plan,assessment} of candidates){
    if(accepted.has(plan.id))continue;
    let reason=assessment.reason;const stake=assessment.economics?.totalStake||0,key=canonicalTicketKey(plan.items);
    if(!reason&&seen.has(key))reason="duplicate_ticket";
    if(!reason&&count>=policy.maxTickets)reason="ticket_limit";
    if(!reason&&spent+stake>policy.dailyBudget)reason="budget_limit";
    if(!reason&&plan.items.some(i=>(fixture.get(ticketFixtureKey(i))||0)+stake>policy.maxFixtureStake))reason="fixture_limit";
    if(!reason&&plan.items.some(i=>(fixtureTickets.get(ticketFixtureKey(i))||0)+1>policy.maxTicketsPerFixture))reason="fixture_ticket_limit";
    if(!reason&&fixtureSets.some(previous=>plan.items.filter(i=>previous.has(ticketFixtureKey(i))).length>policy.maxSharedFixturesPerPair))reason="shared_fixture_limit";
    if(!reason&&plan.items.some(i=>(league.get(i.league||"未知联赛")||0)+stake>policy.maxLeagueStake))reason="league_limit";
    if(reason)decisions.set(plan.id,{code:reason,reason:REJECTION_LABELS[reason]});
    else{add(plan);decisions.delete(plan.id);const {candidateAlternatives,...frozenPlan}=plan;accepted.set(plan.id,{...frozenPlan,sensitivity:assessment.sensitivity,selectionRole:"risk-screened-paper-portfolio"});}
  }
  const output=plans.map(plan=>{
    // Search alternatives are transient, not additional frozen or purchased tickets.
    const {candidateAlternatives,...frozenPlan}=plan;
    return accepted.get(plan.id)||(!decisions.has(plan.id)?frozenPlan:{...frozenPlan,status:"unavailable",items:[],rejectionCode:decisions.get(plan.id).code,reason:decisions.get(plan.id).reason});
  });
  return {plans:output,policy,priorState:"verified",priorStake,dailyStake:spent,selected:accepted.size,modelEligibleCount:new Set(candidates.filter(c=>c.assessment.eligible).map(c=>c.plan.id)).size,rejected:Object.fromEntries(decisions),portfolio:summarizeTicketPortfolio(output)};
}
