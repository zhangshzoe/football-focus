export const PURCHASE_PLAN_STORAGE_KEY="ff-daily-purchase-plans-v1";
export const PURCHASE_PLAN_VERSION=10;
export const PURCHASE_PLAN_DEFINITIONS=[
 {id:"score-double-3",title:"比分双选",rule:"每场2个比分 · 3串1",markets:["score"],matches:3,selections:2},
 {id:"score-single-2",title:"比分单选",rule:"每场1个比分 · 2串1",markets:["score"],matches:2,selections:1},
 {id:"score-double-2",title:"比分双选2串1",rule:"每场2个比分 · 2串1",markets:["score"],matches:2,selections:2},
 {id:"score-single-3",title:"比分单选3串1",rule:"每场1个比分 · 3串1",markets:["score"],matches:3,selections:1},
 {id:"total-double-3",title:"总进球双选",rule:"每场2个进球数 · 3串1",markets:["total"],matches:3,selections:2},
 {id:"total-double-2",title:"总进球双选2串1",rule:"每场2个进球数 · 2串1",markets:["total"],matches:2,selections:2},
 {id:"total-single-2",title:"总进球单选2串1",rule:"每场1个进球数 · 2串1",markets:["total"],matches:2,selections:1},
 {id:"draw-or-handicap-draw-2",title:"平/让平2串1",rule:"平或让平 · 2串1",markets:["had","hhad"],matches:2,selections:1,allowedPicks:["平","让平"]},
 {id:"draw-or-handicap-draw-3",title:"平/让平3串1",rule:"平或让平 · 3串1",markets:["had","hhad"],matches:3,selections:1,allowedPicks:["平","让平"]},
 {id:"result-mixed-3",title:"赛果混合3串1",rule:"胜平负/让球胜平负 · 3串1",markets:["had","hhad"],matches:3,selections:1,mixed:true},
 {id:"result-mixed-4",title:"赛果混合4串1",rule:"胜平负/让球胜平负 · 4串1",markets:["had","hhad"],matches:4,selections:1,mixed:true},
 {id:"result-mixed-5",title:"赛果混合5串1",rule:"胜平负/让球胜平负 · 5串1",markets:["had","hhad"],matches:5,selections:1,mixed:true},
 {id:"had-safe-2",title:"胜平负稳健2串1",rule:"每场首选≥50% · 2串1",markets:["had"],matches:2,selections:1,minLegProbability:50},
 {id:"tenfold-safe-2",title:"10倍稳健 A",rule:"目标净盈利约20元 · 2串1",markets:["had","hhad","total","halfFull"],matches:2,selections:1,minLegProbability:30,targetNetProfit:20,targetProfitTolerance:5},
 {id:"tenfold-safe-3",title:"10倍稳健 B",rule:"目标净盈利约20元 · 3串1",markets:["had","hhad","total","halfFull"],matches:3,selections:1,minLegProbability:30,targetNetProfit:20,targetProfitTolerance:5},
 {id:"tenfold-safe-4",title:"10倍稳健 C",rule:"目标净盈利约20元 · 4串1",markets:["had","hhad","total","halfFull"],matches:4,selections:1,minLegProbability:30,targetNetProfit:20,targetProfitTolerance:5},
 {id:"total-adjacent-double-2",title:"相邻进球双选2串1",rule:"每场相邻2个进球数 · 2串1",markets:["total"],matches:2,selections:2,adjacentPicks:true},
 {id:"half-full-double-3",title:"半全场双选3串1",rule:"每场覆盖2个走势 · 3串1",markets:["halfFull"],matches:3,selections:2,requirePositiveMinProfit:true},
];
export const PURCHASE_PLAN_DAILY_TIME="17:00";

export const PURCHASE_PLAN_MODULES=[
 {id:"score",title:"比分方案",description:"比分单选、双选与不同串关"},
 {id:"total",title:"进球数方案",description:"总进球单选、双选与相邻覆盖"},
 {id:"result",title:"赛果方案",description:"胜平负与让球胜平负组合"},
 {id:"draw",title:"平局 / 让平",description:"专门跟踪平与让平组合"},
 {id:"halfFull",title:"半全场方案",description:"半全场走势覆盖组合"},
 {id:"tenfold",title:"10倍目标",description:"2～4场、目标净盈利约20元"},
];
export const purchasePlanModuleId=planId=>{
 const id=String(planId||"");
 if(id.startsWith("score-"))return"score";
 if(id.startsWith("total-"))return"total";
 if(id.startsWith("draw-or-handicap-draw-"))return"draw";
 if(id.startsWith("half-full-"))return"halfFull";
 if(id.startsWith("tenfold-"))return"tenfold";
 return"result";
};
const settledPlanStatuses=new Set(["won","lost","corrected_won","corrected_lost","void_won","void_lost"]);
const wonPlanStatuses=new Set(["won","corrected_won","void_won"]);
export const summarizePurchasePlans=plans=>{
 const settled=(plans||[]).filter(plan=>settledPlanStatuses.has(plan.status)),won=settled.filter(plan=>wonPlanStatuses.has(plan.status)).length;
 const stake=settled.reduce((sum,plan)=>sum+safeNumber(plan.stake),0),returned=settled.reduce((sum,plan)=>sum+safeNumber(plan.simulatedReturn),0);
 return{settled:settled.length,won,rate:settled.length?won/settled.length*100:0,stake,returned,net:returned-stake};
};
export const summarizePurchasePlanModules=planSets=>{
 const plans=(planSets||[]).flatMap(item=>Array.isArray(item?.plans)?item.plans:[]);
 return Object.fromEntries(PURCHASE_PLAN_MODULES.map(module=>[module.id,summarizePurchasePlans(plans.filter(plan=>purchasePlanModuleId(plan.id)===module.id))]));
};

export const MARKET_META={
 had:{name:"胜平负",code:"HAD",labels:["胜","平","负"],maxPass:8},
 hhad:{name:"让球胜平负",code:"HHAD",labels:["让胜","让平","让负"],maxPass:8},
 score:{name:"比分",code:"CRS",labels:["1:0","2:0","2:1","3:0","3:1","3:2","4:0","4:1","4:2","5:0","5:1","5:2","胜其他","0:0","1:1","2:2","3:3","平其他","0:1","0:2","1:2","0:3","1:3","2:3","0:4","1:4","2:4","0:5","1:5","2:5","负其他"],maxPass:4},
 total:{name:"总进球数",code:"TTG",labels:["0球","1球","2球","3球","4球","5球","6球","7+球"],maxPass:6},
 halfFull:{name:"半全场",code:"HAFU",labels:["胜胜","胜平","胜负","平胜","平平","平负","负胜","负平","负负"],maxPass:4},
};
const safeNumber=value=>Number.isFinite(Number(value))?Number(value):0;
const pointList=(points,labels)=>Array.isArray(points)?points.map((point,index)=>typeof point==="object"?{score:String(point.score||labels[index]||""),probability:safeNumber(point.probability)}:{score:labels[index]||"",probability:safeNumber(point)}):[];
const resultFromScore=(score)=>{const [home,away]=String(score||"").split(":").map(Number);return !Number.isFinite(home)||!Number.isFinite(away)?"":home>away?"胜":home===away?"平":"负"};
const zonedTime=value=>{const text=String(value||"").trim();if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(text))return NaN;return Date.parse(text)};
const freshnessLimit=distance=>distance<=2*3600000?20*60000:distance<=6*3600000?60*60000:distance<=24*3600000?3*3600000:6*3600000;

function matchMarkets(report,official,decisionAt){
 const odds=official?.marketOdds||{},signal=report.marketSignal||{};
 const kickoff=zonedTime(official?.kickoffAt||report.kickoffAt),sourceAt=Date.parse(report.sourceFetchedAt||report.predictionGeneratedAt||report.generatedAt||"");
 if(!Number.isFinite(kickoff)||kickoff<=decisionAt||!Number.isFinite(sourceAt)||sourceAt>decisionAt+5*60000||decisionAt-sourceAt>freshnessLimit(kickoff-decisionAt))return[];
 const had=report.hadProbabilities?.length?report.hadProbabilities:pointList([report.probabilities?.home,report.probabilities?.draw,report.probabilities?.away],MARKET_META.had.labels);
 const hhad=report.hhadProbabilities?.length?report.hhadProbabilities:pointList(signal.modeledHhad,MARKET_META.hhad.labels);
 const score=report.combinedScores?.length?report.combinedScores:report.scores||report.oddsScores||[];
 const total=report.totalGoalProbabilities?.length?report.totalGoalProbabilities:pointList(signal.modeledTotalGoals,MARKET_META.total.labels);
 const halfFull=report.halfFullProbabilities?.length?report.halfFullProbabilities:pointList(signal.modeledHalfFull,MARKET_META.halfFull.labels);
 return [
  ["had",had,odds["胜平负"]||signal.officialOdds||official?.odds],
  ["hhad",hhad,odds["让球胜平负"]||signal.officialHhadOdds],
  ["score",score,odds["比分"]],
  ["total",total,odds["总进球数"]],
 ["halfFull",halfFull,odds["半全场"]],
 ].flatMap(([market,points,marketOdds])=>{
  const meta=MARKET_META[market],eligibility=official?.marketEligibility?.[meta.name],allowedPassCounts=Array.isArray(eligibility?.allowedPassCounts)?eligibility.allowedPassCounts.map(Number).filter(value=>Number.isInteger(value)&&value>=1&&value<=meta.maxPass):[];
  if(eligibility?.qualification!=="qualified"||String(eligibility?.salesStatus||"").toLowerCase()!=="selling"||eligibility?.marketCode!==meta.code||!allowedPassCounts.length)return[];
  if(market==="hhad"&&(!String(eligibility.handicap??"").trim()||!Array.isArray(points)||!points.length))return[];
  const cutoff=eligibility.cutoffAt?zonedTime(eligibility.cutoffAt):kickoff;
  if(!Number.isFinite(cutoff)||cutoff<=decisionAt)return[];
  const byLabel=new Map(pointList(points,meta.labels).map(point=>[point.score,point.probability]));
  return meta.labels.map((pick,index)=>({pick,probability:safeNumber(byLabel.get(pick)),odd:safeNumber(marketOdds?.[index])})).filter(item=>item.probability>0&&item.odd>1).sort((a,b)=>b.probability-a.probability).map(item=>({
   matchId:String(report.id),officialMatchId:String(official.officialMatchId||official.matchId),salesDate:String(official.salesDate||report.salesDate||""),matchDate:String(report.matchDate||official?.matchDate||report.time||""),kickoffAt:String(official.kickoffAt),sourceFetchedAt:String(report.sourceFetchedAt||""),matchStatus:String(official.matchStatus||report.matchStatus||""),league:String(report.league||official?.league||""),home:String(report.home),away:String(report.away),handicap:market==="hhad"?String(eligibility.handicap):String(report.handicap||signal.officialHandicap||official?.handicap||""),market,marketCode:meta.code,marketName:meta.name,maxPass:meta.maxPass,allowedPassCounts,cutoffAt:eligibility.cutoffAt||official.kickoffAt,ruleVersion:eligibility.ruleVersion||"",...item,
  }));
 });
}

function combinations(items,size){const output=[];const walk=(start,picked)=>{if(picked.length===size){output.push([...picked]);return}for(let index=start;index<=items.length-(size-picked.length);index++){picked.push(items[index]);walk(index+1,picked);picked.pop()}};walk(0,[]);return output}
function goalNumber(pick){const matched=String(pick||"").match(/^(\d+)(?:\+)?球$/);return matched?Number(matched[1]):NaN}
function legFrom(items,count,{adjacentPicks=false,minLegProbability=0}={}){
 const ranked=[...items].sort((a,b)=>b.probability-a.probability);
 let selections=ranked.slice(0,count);
 if(adjacentPicks&&count===2){
  const pairs=combinations(ranked,2).filter(pair=>pair.every(item=>Number.isFinite(goalNumber(item.pick)))&&Math.abs(goalNumber(pair[0].pick)-goalNumber(pair[1].pick))===1).sort((left,right)=>right.reduce((sum,item)=>sum+item.probability,0)-left.reduce((sum,item)=>sum+item.probability,0));
  selections=pairs[0]||[];
 }
 if(selections.length!==count)return null;
 const probability=selections.reduce((sum,item)=>sum+item.probability,0);
 if(probability<safeNumber(minLegProbability))return null;
 const base=selections[0];
 return{...base,picks:selections.map(({pick,probability,odd})=>({pick,probability,odd})),pick:selections.map(item=>item.pick).join(" / "),probability,odd:0};
}
function choosePlan(groups,definition){
 const allowedPicks=Array.isArray(definition.allowedPicks)?new Set(definition.allowedPicks):null;
 const variants=groups.map(group=>definition.markets.flatMap(market=>{const items=group.filter(item=>item.market===market&&(!allowedPicks||allowedPicks.has(item.pick)));const leg=legFrom(items,definition.selections,{adjacentPicks:Boolean(definition.adjacentPicks),minLegProbability:definition.minLegProbability});return leg?[leg]:[]})).filter(group=>group.length);
 let best=null;
 for(const fixtureSet of combinations(variants,definition.matches)){
  const walk=(index,legs)=>{
   if(index<fixtureSet.length){for(const leg of fixtureSet[index])walk(index+1,[...legs,leg]);return}
   if(!legs.every(leg=>leg.allowedPassCounts.includes(definition.matches)))return;
   if(definition.mixed&&new Set(legs.map(leg=>leg.market)).size<2)return;
   const probability=legs.reduce((value,leg)=>value*leg.probability/100,1),betCount=legs.reduce((value,leg)=>value*leg.picks.length,1),stake=betCount*2;
   const minWinningReturn=2*legs.reduce((value,leg)=>value*Math.min(...leg.picks.map(item=>item.odd)),1),maxWinningReturn=2*legs.reduce((value,leg)=>value*Math.max(...leg.picks.map(item=>item.odd)),1);
   const candidate={items:legs,probability,betCount,stake,minWinningReturn,maxWinningReturn,minWinningProfit:minWinningReturn-stake,maxWinningProfit:maxWinningReturn-stake};
   if(definition.requirePositiveMinProfit&&candidate.minWinningProfit<=0)return;
   const target=Number(definition.targetNetProfit),tolerance=Math.max(0,safeNumber(definition.targetProfitTolerance));
   if(Number.isFinite(target)){
    if(candidate.minWinningProfit<=0)return;
    candidate.targetDistance=Math.abs(candidate.minWinningProfit-target);
    candidate.inTargetRange=candidate.targetDistance<=tolerance;
   }
   const better=!best||(
    Number.isFinite(target)
      ? candidate.inTargetRange!==best.inTargetRange
        ? candidate.inTargetRange
        : candidate.inTargetRange
          ? candidate.probability>best.probability
          : candidate.targetDistance<best.targetDistance||(candidate.targetDistance===best.targetDistance&&candidate.probability>best.probability)
      : candidate.probability>best.probability
   );
   if(better)best=candidate;
  };walk(0,[]);
 }
 return best;
}

const dateOnly=value=>String(value||"").match(/\d{4}-\d{2}-\d{2}/)?.[0]||"";
const officialKey=match=>`${String(match?.officialMatchId||match?.matchId||"")}|${dateOnly(match?.salesDate||match?.matchDate||match?.kickoffAt)}`;

export function generatePurchasePlans({date,reports,officialMatches,generatedAt=new Date().toISOString()}){
 const decisionAt=Date.parse(generatedAt);if(!Number.isFinite(decisionAt))throw new Error("方案生成时间无效，拒绝生成可售组合");
 const officialByKey=new Map((officialMatches||[]).filter(match=>match?.officialMatchId||match?.matchId).map(match=>[officialKey(match),match]));
 const pairs=(reports||[]).map(report=>({report,official:officialByKey.get(officialKey(report))})).filter(pair=>pair.official&&pair.report?.officialMappingStatus==="verified"&&!pair.report.isMock&&String(pair.official.matchStatus||"").toLowerCase()==="selling");
 const groups=pairs.map(({report,official})=>matchMarkets(report,official,decisionAt)).filter(group=>group.length);
 const plans=[];
 for(const definition of PURCHASE_PLAN_DEFINITIONS){
  const found=choosePlan(groups,definition);
  if(!found){plans.push({id:definition.id,title:definition.title,rule:definition.rule,status:"unavailable",reason:"当前合规玩法、场次数或官方赔率不足，暂不能生成该组合。",items:[],combinedOdd:0,estimatedProbability:0,betCount:0,stake:0,minWinningReturn:0,maxWinningReturn:0,theoreticalReturn:0});continue}
  plans.push({id:definition.id,title:definition.title,rule:definition.rule,status:"pending",items:found.items,passName:`${definition.matches}串1`,combinedOdd:0,estimatedProbability:found.probability,betCount:found.betCount,stake:found.stake,minWinningReturn:found.minWinningReturn,maxWinningReturn:found.maxWinningReturn,minWinningProfit:found.minWinningProfit,maxWinningProfit:found.maxWinningProfit,theoreticalReturn:found.maxWinningReturn});
 }
 return{version:PURCHASE_PLAN_VERSION,date,generatedAt,scheduledTime:PURCHASE_PLAN_DAILY_TIME,source:"每日17:00预测版本 + 中国体育彩票生成时固定奖金",plans};
}

export function settlePurchasePlan(plan,results,{now=Date.now()}={}){
 if(plan.status==="unavailable")return plan;
 const lookup=new Map();for(const result of results||[]){const date=dateOnly(result.date||result.matchDate);if((result.officialMatchId||result.matchId)&&date)lookup.set(`official:${String(result.officialMatchId||result.matchId)}|${date}`,result);if(result.id&&date)lookup.set(`display:${String(result.id)}|${date}`,result)}
 let unresolved=false,hasVoid=false,hasSettledVoid=false,hasCorrection=false;
 const items=plan.items.map(item=>{
  const date=dateOnly(item.matchDate||item.salesDate||item.kickoffAt),result=lookup.get(`official:${item.officialMatchId}|${date}`)||lookup.get(`display:${item.matchId}|${date}`);
  if(!result){unresolved=true;const kickoff=zonedTime(item.kickoffAt),finished=/finish|complete|ended/.test(String(item.matchStatus||"").toLowerCase())||(Number.isFinite(kickoff)&&now>=kickoff+3*3600000);return{...item,settlementState:finished?"awaiting_official_result":"waiting_match",actual:finished?"等待官方结果":"待赛",result:finished?"已完赛待官方结果":"待赛"}}
  const status=String(result.status||"").toLowerCase();
  if(/cancel|void|invalid|abandon/.test(status)){if(result.voidRule==="odds_one"){hasSettledVoid=true;return{...item,settlementState:"void_settled",settlementOdd:1,actual:"无效（按1.00结算）",result:"无效结算"}}hasVoid=true;return{...item,settlementState:"void",actual:"无效",result:"等待规则确认"}}
  if(/postpon/.test(status)){unresolved=true;return{...item,settlementState:"postponed",actual:"延期",result:"延期"}}
  const hhadActual=result.hhadResult?`让${String(result.hhadResult).match(/[胜平负](?!.*[胜平负])/)?.[0]||""}`:"",totalRaw=String(result.totalGoalsResult||"").replace(/\s/g,"");
  const actual=item.market==="had"?(result.hadResult||resultFromScore(result.fullScore)):item.market==="hhad"?hhadActual:item.market==="score"?(result.scoreResult||result.fullScore):item.market==="total"?(totalRaw?`${totalRaw.replace(/球$/,"")}球`:""):(result.halfScore&&result.fullScore?`${resultFromScore(result.halfScore)}${resultFromScore(result.fullScore)}`:"");
  if(!actual){unresolved=true;return{...item,settlementState:"field_pending",actual:"字段待补",result:"字段待补"}}
  const corrected=/correct|revise|订正/.test(status);if(corrected)hasCorrection=true;
  const picks=Array.isArray(item.picks)&&item.picks.length?item.picks.map(selection=>selection.pick):[item.pick];
  return{...item,actual,result:picks.includes(actual)?"命中":"未中",settlementState:corrected?"corrected":"settled"};
 });
 const resolved=items.filter(item=>["settled","corrected","void_settled"].includes(item.settlementState)),won=!unresolved&&!hasVoid&&resolved.length===items.length&&items.every(item=>item.result==="命中"||item.settlementState==="void_settled");
 const status=hasVoid?"void":unresolved?(items.some(item=>item.settlementState==="field_pending")?"field_pending":items.some(item=>item.settlementState==="postponed")?"postponed":items.some(item=>item.settlementState==="awaiting_official_result")?"awaiting_result":"pending"):hasCorrection?(won?"corrected_won":"corrected_lost"):hasSettledVoid?(won?"void_won":"void_lost"):won?"won":"lost";
 const winningSelections=items.map(item=>item.settlementState==="void_settled"?{odd:1}:((item.picks||[]).find(selection=>selection.pick===item.actual)||{odd:item.odd||0})),simulatedReturn=won?2*winningSelections.reduce((value,item)=>value*safeNumber(item.odd),1):0;
 return{...plan,items,status,simulatedReturn};
}
