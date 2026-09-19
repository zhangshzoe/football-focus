const HAD_LABELS=["胜","平","负"];

const finite=value=>Number.isFinite(Number(value));
const ranked=points=>[...(points||[])].filter(point=>point&&String(point.score||"").trim()&&finite(point.probability)).sort((a,b)=>Number(b.probability)-Number(a.probability));
const scoreParts=value=>String(value||"").match(/^(\d+)\s*:\s*(\d+)$/)?.slice(1).map(Number)||[];
const outcome=(home,away)=>home>away?"胜":home===away?"平":"负";
const opposite=(forecast,actual)=>(forecast==="胜"&&actual==="负")||(forecast==="负"&&actual==="胜");
const normalizeTotal=value=>{const clean=String(value||"").replace("球","");const number=Number(clean.replace("+",""));return finite(number)&&number>=7?"7+":clean};
const normalizeHhad=value=>{const match=String(value||"").replace(/\s+/g,"").match(/(?:让)?([胜平负])$/);return match?`让${match[1]}`:""};

function normalizedVector(points,labels=HAD_LABELS){
 const values=labels.map(label=>Math.max(0,Number((points||[]).find(point=>String(point.score)===label)?.probability)||0));
 const sum=values.reduce((total,value)=>total+value,0);
 return sum>0?values.map(value=>value/sum):[];
}

function probabilityMetrics(rows,selector){
 const buckets=Array.from({length:5},(_,index)=>({range:`${index*20}–${(index+1)*20}%`,count:0,probability:0,hits:0}));
 let brier=0,logLoss=0,hits=0,sampleSize=0;
 rows.forEach(row=>{
  const probabilities=normalizedVector(selector(row));
  const actualIndex=HAD_LABELS.indexOf(row.actualHad);
  if(probabilities.length!==3||actualIndex<0)return;
  sampleSize++;
  brier+=probabilities.reduce((sum,value,index)=>sum+(value-(index===actualIndex?1:0))**2,0);
  logLoss-=Math.log(Math.max(.000001,probabilities[actualIndex]));
  const predictedIndex=probabilities.indexOf(Math.max(...probabilities));
  if(predictedIndex===actualIndex)hits++;
  probabilities.forEach((value,index)=>{const bucket=buckets[Math.min(4,Math.floor(value*5))];bucket.count++;bucket.probability+=value;if(index===actualIndex)bucket.hits++;});
 });
 const reliability=buckets.map(bucket=>({range:bucket.range,count:bucket.count,meanProbability:bucket.count?bucket.probability/bucket.count:0,observedRate:bucket.count?bucket.hits/bucket.count:0}));
 const pointCount=reliability.reduce((sum,bucket)=>sum+bucket.count,0);
 const ece=pointCount?reliability.reduce((sum,bucket)=>sum+bucket.count*Math.abs(bucket.meanProbability-bucket.observedRate),0)/pointCount:0;
 return{sampleSize,brier:sampleSize?brier/sampleSize:0,logLoss:sampleSize?logLoss/sampleSize:0,ece,hitRate:sampleSize?hits/sampleSize:0,reliability};
}

function marketMetrics(rows){
 let scoreTop1=0,scoreTop3=0,scoreN=0,totalTop1=0,totalTop2=0,totalN=0,hhadHit=0,hhadN=0,halfFullTop1=0,halfFullTop2=0,halfFullN=0;
 rows.forEach(row=>{
  const scoreForecasts=ranked(row.scoreDistribution),actualScore=row.fullScore;
  if(scoreForecasts.length&&actualScore){scoreN++;if(scoreForecasts[0]?.score===actualScore)scoreTop1++;if(scoreForecasts.slice(0,3).some(point=>point.score===actualScore))scoreTop3++;}
  const goals=scoreParts(row.fullScore),actualTotal=goals.length===2?(goals[0]+goals[1]>=7?"7+":String(goals[0]+goals[1])):"",totalForecasts=ranked(row.totalGoalProbabilities);
  if(totalForecasts.length&&actualTotal){totalN++;if(normalizeTotal(totalForecasts[0]?.score)===actualTotal)totalTop1++;if(totalForecasts.slice(0,2).some(point=>normalizeTotal(point.score)===actualTotal))totalTop2++;}
  const hhadForecasts=ranked(row.hhadProbabilities),handicap=Number(row.handicap||0),actualHhad=goals.length===2?`让${outcome(goals[0]+handicap,goals[1])}`:"";
  if(hhadForecasts.length&&actualHhad){hhadN++;if(normalizeHhad(hhadForecasts[0]?.score)===actualHhad)hhadHit++;}
  const half=scoreParts(row.halfScore),actualHalfFull=goals.length===2&&half.length===2?`${outcome(half[0],half[1])}${outcome(goals[0],goals[1])}`:"",halfForecasts=ranked(row.halfFullProbabilities);
  if(halfForecasts.length&&actualHalfFull){halfFullN++;if(halfForecasts[0]?.score===actualHalfFull)halfFullTop1++;if(halfForecasts.slice(0,2).some(point=>point.score===actualHalfFull))halfFullTop2++;}
 });
 return{score:{sampleSize:scoreN,top1:scoreN?scoreTop1/scoreN:0,top3:scoreN?scoreTop3/scoreN:0},hhad:{sampleSize:hhadN,top1:hhadN?hhadHit/hhadN:0},total:{sampleSize:totalN,top1:totalN?totalTop1/totalN:0,top2:totalN?totalTop2/totalN:0},halfFull:{sampleSize:halfFullN,top1:halfFullN?halfFullTop1/halfFullN:0,top2:halfFullN?halfFullTop2/halfFullN:0}};
}

function errorFor(row){
 const model=ranked(row.modelHad),actualPoint=model.find(point=>point.score===row.actualHad),top=model[0],rank=model.findIndex(point=>point.score===row.actualHad)+1;
 if(!row.officialMatchId||!row.kickoffAt||model.length!==3||!row.fullScore)return{code:"data_error",label:"数据错误或缺失",trainable:false,detail:"缺少官方比赛 ID、开赛时间、完整概率或赛果，先修复数据链路。"};
 if(top?.score===row.actualHad)return{code:"correct",label:"正常命中",trainable:false,detail:"胜平负首选与赛果一致。"};
 if(Number(top?.probability)>50&&opposite(top?.score,row.actualHad))return{code:"overconfidence",label:"强方向反转",trainable:true,detail:"超过 50% 的胜负强方向完全反转，应重点检查概率校准和赛前情报。"};
 if(rank===2)return{code:"ranking_error",label:"第二顺位命中",trainable:true,detail:"实际赛果已被概率分布覆盖，但首选排序需要校准。"};
 const scoreForecasts=ranked(row.scoreDistribution),scoreCovered=scoreForecasts.slice(0,3).some(point=>point.score===row.fullScore);
 const goals=scoreParts(row.fullScore),actualTotal=goals.length===2?(goals[0]+goals[1]>=7?"7+":String(goals[0]+goals[1])):"",totalCovered=ranked(row.totalGoalProbabilities).slice(0,2).some(point=>normalizeTotal(point.score)===actualTotal);
 if(!scoreCovered||!totalCovered)return{code:"distribution_shape",label:"比分分布偏窄",trainable:true,detail:"实际比分或总进球落在主要候选之外，需要修正均值、方差与尾部概率。"};
 if((row.intelligenceCoverage||0)<=0)return{code:"intelligence_gap",label:"赛前情报缺口",trainable:true,detail:"该场没有可验证的赛前情报证据，先补首发、伤停、轮换与盘口变化。"};
 const actualProbability=Number(actualPoint?.probability||0),leadGap=Number(top?.probability||0)-actualProbability;
 if(actualProbability<20&&leadGap>=15)return{code:"upset",label:"低概率爆冷",trainable:false,detail:"实际赛果在赛前分布中概率很低，暂列不可稳定学习的爆冷样本。"};
 return{code:"unexplained",label:"待核验赛中事件",trainable:false,detail:"赛前分布未明显失真，需要红牌、点球、伤退与 xG 时间线后再归因。"};
}

function foldValidation(rows){
 const eligible=rows.filter(row=>normalizedVector(row.challengerHad).length===3&&normalizedVector(row.modelHad).length===3&&normalizedVector(row.marketHad).length===3);
 const foldSize=Math.floor(eligible.length/4),folds=[];
 if(foldSize<5)return{sampleSize:eligible.length,folds:0,wins:0,items:[]};
 for(let index=0;index<4;index++){
  const start=index*foldSize,end=index===3?eligible.length:(index+1)*foldSize,test=eligible.slice(start,end),challenger=probabilityMetrics(test,row=>row.challengerHad),champion=probabilityMetrics(test,row=>row.modelHad),market=probabilityMetrics(test,row=>row.marketHad);
  folds.push({index:index+1,sampleSize:test.length,challengerBrier:challenger.brier,championBrier:champion.brier,marketBrier:market.brier,win:challenger.brier<champion.brier&&challenger.brier<market.brier});
 }
 return{sampleSize:eligible.length,folds:folds.length,wins:folds.filter(fold=>fold.win).length,items:folds};
}

function evaluateWindow(rows){
 const champion=probabilityMetrics(rows,row=>row.modelHad),challenger=probabilityMetrics(rows,row=>row.challengerHad),market=probabilityMetrics(rows,row=>row.marketHad);
 return{sampleSize:rows.length,champion,challenger,market,markets:marketMetrics(rows)};
}

export function buildModelEvaluation(input){
 const rows=[...(input||[])].map(row=>{const goals=scoreParts(row.fullScore);return{...row,actualHad:goals.length===2?outcome(goals[0],goals[1]):""}}).filter(row=>row.key&&row.actualHad);
 const grouped=new Map();rows.forEach(row=>{const key=row.officialMatchId||row.key;grouped.set(key,[...(grouped.get(key)||[]),row]);});
 const unique=Array.from(grouped.values()).map(items=>[...items].filter(row=>!finite(Date.parse(row.kickoffAt||""))||Date.parse(row.capturedAt||"")<=Date.parse(row.kickoffAt)).sort((a,b)=>Date.parse(b.capturedAt||"")-Date.parse(a.capturedAt||""))[0]||items[0]).sort((a,b)=>String(a.kickoffAt||a.salesDate).localeCompare(String(b.kickoffAt||b.salesDate)));
 const windows={all:evaluateWindow(unique),recent100:evaluateWindow(unique.slice(-100)),recent50:evaluateWindow(unique.slice(-50))};
 const segmentNames=new Map();
 unique.forEach(row=>segmentNames.set(row.league||"其他联赛",[...(segmentNames.get(row.league||"其他联赛")||[]),row]));
 const leagues=Array.from(segmentNames.entries()).map(([name,items])=>{const metrics=evaluateWindow(items);return{name,sampleSize:items.length,underpowered:items.length<20,champion:metrics.champion,market:metrics.market,deltaBrier:metrics.champion.sampleSize&&metrics.market.sampleSize?metrics.champion.brier-metrics.market.brier:0}}).sort((a,b)=>b.sampleSize-a.sampleSize);
 const confidenceBands=[{name:"<35%",min:0,max:35},{name:"35–50%",min:35,max:50},{name:">50%",min:50,max:101}].map(band=>{const items=unique.filter(row=>{const top=ranked(row.modelHad)[0];return top&&Number(top.probability)>=band.min&&Number(top.probability)<band.max});return{name:band.name,...evaluateWindow(items)}});
 const errors=unique.map(row=>({...errorFor(row),key:row.key,id:row.id,league:row.league,home:row.home,away:row.away,actual:row.actualHad,predicted:ranked(row.modelHad)[0]?.score||"—"}));
 const errorSummary=Array.from(new Set(errors.map(error=>error.code))).map(code=>{const items=errors.filter(error=>error.code===code),sample=items[0];return{code,label:sample.label,trainable:sample.trainable,count:items.length,rate:unique.length?items.length/unique.length:0}}).sort((a,b)=>b.count-a.count);
 const alignedShadowRows=unique.filter(row=>normalizedVector(row.challengerHad).length===3&&normalizedVector(row.modelHad).length===3&&normalizedVector(row.marketHad).length===3),validation=foldValidation(unique),challenger=probabilityMetrics(alignedShadowRows,row=>row.challengerHad),champion=probabilityMetrics(alignedShadowRows,row=>row.modelHad),market=probabilityMetrics(alignedShadowRows,row=>row.marketHad);
 const dataHealth={officialIdCoverage:unique.length?unique.filter(row=>row.officialMatchId).length/unique.length:0,kickoffCoverage:unique.length?unique.filter(row=>Number.isFinite(Date.parse(row.kickoffAt||""))).length/unique.length:0,marketCoverage:unique.length?market.sampleSize/unique.length:0,resultCoverage:unique.length?unique.filter(row=>row.fullScore).length/unique.length:0,intelligenceCoverage:unique.length?unique.filter(row=>(row.intelligenceCoverage||0)>0).length/unique.length:0,completeCoverage:unique.length?unique.filter(row=>row.completeness>=7).length/unique.length:0};
 const gates=[
  {key:"sample",label:"未来独立样本 ≥ 100",passed:challenger.sampleSize>=100,value:`${challenger.sampleSize}/100`},
  {key:"folds",label:"4折中至少3折领先",passed:validation.folds>=4&&validation.wins>=3,value:`${validation.wins}/${validation.folds||4}`},
  {key:"brier",label:"Brier 至少改善 0.005",passed:challenger.sampleSize>0&&challenger.brier<=Math.min(champion.brier,market.brier)-.005,value:challenger.sampleSize?`${(challenger.brier-Math.min(champion.brier,market.brier)).toFixed(3)}`:"无样本"},
  {key:"logloss",label:"Log Loss 不劣于基线",passed:challenger.sampleSize>0&&challenger.logLoss<=Math.min(champion.logLoss,market.logLoss),value:challenger.sampleSize?challenger.logLoss.toFixed(3):"无样本"},
  {key:"calibration",label:"概率校准误差改善",passed:challenger.sampleSize>0&&challenger.ece<Math.min(champion.ece,market.ece),value:challenger.sampleSize?`${(challenger.ece*100).toFixed(1)}%`:"无样本"},
  {key:"data",label:"关键数据完整度 ≥ 95%",passed:dataHealth.officialIdCoverage>=.95&&dataHealth.kickoffCoverage>=.95&&dataHealth.marketCoverage>=.95,value:`${(Math.min(dataHealth.officialIdCoverage,dataHealth.kickoffCoverage,dataHealth.marketCoverage)*100).toFixed(1)}%`},
 ];
 const passed=gates.every(gate=>gate.passed),status=passed?"eligible_for_promotion":challenger.sampleSize?"shadow_validation":"insufficient_challenger_data";
 const rollback={active:false,threshold:.01,recentDelta:windows.recent50.champion.sampleSize&&windows.recent50.market.sampleSize?windows.recent50.champion.brier-windows.recent50.market.brier:0,triggered:false};
 rollback.triggered=rollback.recentDelta>rollback.threshold;
 rollback.active=rollback.triggered;
 return{generatedAt:new Date().toISOString(),sampleSize:unique.length,windows,segments:{leagues,confidenceBands},errors:{items:errors,summary:errorSummary},dataHealth,promotion:{status,eligible:passed,gates,validation,alignedComparison:{sampleSize:alignedShadowRows.length,champion,challenger,market}},rollback};
}

export const MODEL_PROMOTION_POLICY={minimumFutureSample:100,minimumWinningFolds:3,foldCount:4,minimumBrierGain:.005,minimumCompleteness:.95,rollbackBrierDegradation:.01};
