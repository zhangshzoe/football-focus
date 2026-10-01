import {selectDecisionObservations} from "./snapshot-decision-policy.js";
import {completeDistribution,scoreProbability,summarizeProbability,frozenOfficialMarkets,projectOfficialScores,pairedInterval,HAD_LABELS,EXACT_SCORE_LABELS} from "./probability-evaluation.js";
import {MARKET_META} from "./purchase-plan-engine.js";
import {probabilitySlotTime} from "./slot-probability-observations.js";
const scoreParts=value=>String(value||"").match(/^(\d+)\s*:\s*(\d+)$/)?.slice(1).map(Number)||[];
const outcome=(h,a)=>h>a?"胜":h===a?"平":"负";
const labels={had:HAD_LABELS,hhad:["让胜","让平","让负"],total:MARKET_META.total.labels,halfFull:MARKET_META.halfFull.labels,score:EXACT_SCORE_LABELS,scoreOfficial:MARKET_META.score.labels};
const opposite=(a,b)=>a==="胜"&&b==="负"||a==="负"&&b==="胜";
const cleanTotal=value=>{const v=String(value).replace("球","");return Number(v.replace("+",""))>=7?"7+球":v+"球";};
function assessed(row){
 const goals=scoreParts(row.fullScore),half=scoreParts(row.halfScore),actualHad=goals.length===2?outcome(...goals):"";
 let baseline=frozenOfficialMarkets(row.modelInput);
 if(baseline&&(String(row.modelInput?.official?.officialMatchId||"")!==String(row.officialMatchId||"")||String(row.modelInput?.official?.salesDate||"")!==String(row.salesDate||"")||Date.parse(row.modelInput?.official?.kickoffAt||"")!==Date.parse(row.kickoffAt||"")))baseline=null;
 const actualTotal=goals.length===2?(goals[0]+goals[1]>=7?"7+":goals[0]+goals[1])+"球":"";
 const knownHandicap=baseline&&Number.isInteger(baseline.handicap);
 const actualHhad=knownHandicap&&goals.length===2?"让"+outcome(goals[0]+baseline.handicap,goals[1]):"";
 const actualHalf=half.length===2&&goals.length===2&&half.every((n,i)=>n<=goals[i])?outcome(...half)+actualHad:"";
 const actualScore=goals.length===2?goals[0]+":"+goals[1]:"";
 const crsLabel=labels.scoreOfficial.includes(actualScore)?actualScore:actualHad==="胜"?"胜其他":actualHad==="平"?"平其他":"负其他";
 const vectors={had:completeDistribution(row.modelHad,labels.had),hhad:completeDistribution(row.hhadProbabilities,labels.hhad),total:completeDistribution(row.totalGoalProbabilities,labels.total,cleanTotal),halfFull:completeDistribution(row.halfFullProbabilities,labels.halfFull),score:completeDistribution(row.scoreDistribution,labels.score),scoreOfficial:projectOfficialScores(row.scoreDistribution)};
 const actuals={had:actualHad,hhad:actualHhad,total:actualTotal,halfFull:actualHalf,score:actualScore,scoreOfficial:actualScore?crsLabel:""},markets={};
 for(const key of Object.keys(labels)){const index=labels[key].indexOf(actuals[key]);markets[key]={model:scoreProbability(vectors[key],index,key==="total"),market:key==="score"?null:scoreProbability(baseline?.[key==="scoreOfficial"?"score":key],index,key==="total")};}
 const shadowTime=Date.parse(row.shadowGeneratedAt||"");
 return{...row,actualHad,baseline,markets,vectors,challenger:Number.isFinite(shadowTime)&&shadowTime<=Date.parse(row.decisionTargetAt)?scoreProbability(completeDistribution(row.challengerHad,labels.had),labels.had.indexOf(actualHad)):null};
}
function errorFor(row){
 const p=row.markets.had.model,rank=p?.rank,top=p?.vector.indexOf(Math.max(...p.vector)),predicted=top===undefined?"—":HAD_LABELS[top],shared={trainable:false,requiresAggregateValidation:true,predicted};
 if(!p)return{...shared,code:"data_error",label:"概率数据不足",detail:"缺少完整概率；先修复数据，不把缺失当预测失败。"};
 if(rank===1)return{...shared,code:"correct",label:"首选命中",detail:"一次命中不证明模型可靠。"};
 if(p.vector[top]>.5&&opposite(predicted,row.actualHad))return{...shared,code:"strong_direction_miss",label:"强方向未兑现",detail:"这是结果模式，不足以证明过度自信；需用独立样本的概率校准核验。"};
 if(rank===2)return{...shared,code:"second_choice_hit",label:"第二顺位命中",detail:"正确模型也会出现次选结果，不能据此认定排序错误或直接调参。"};
 if(row.markets.score.model?.rank>3||row.markets.total.model?.rank>2)return{...shared,code:"outside_top_k",label:"未进入主要候选",detail:"未进Top3/Top2不证明尾部偏窄；完整概率评分和批量样本才可判断分布误差。"};
 return{...shared,code:"cause_unverified",label:"原因未核验",detail:"没有证据区分随机波动、输入缺口和模型偏差；赛后事件不能倒灌赛前输入。"};
}
function evaluateWindow(rows){
 const pairs=rows.filter(r=>r.markets.had.model&&r.markets.had.market),triples=pairs.filter(r=>r.challenger),champion=summarizeProbability(pairs.map(r=>r.markets.had.model)),market=summarizeProbability(pairs.map(r=>r.markets.had.market)),challenger=summarizeProbability(triples.map(r=>r.challenger)),markets={};
 for(const key of ["score","scoreOfficial","hhad","total","halfFull"]){const valid=rows.filter(r=>r.markets[key].model),paired=valid.filter(r=>r.markets[key].market);
  markets[key]={...summarizeProbability(valid.map(r=>r.markets[key].model)),paired:{sampleSize:paired.length,model:summarizeProbability(paired.map(r=>r.markets[key].model)),market:summarizeProbability(paired.map(r=>r.markets[key].market)),brierInterval:pairedInterval(paired.map(r=>({...r,...r.markets[key]}))),logLossInterval:pairedInterval(paired.map(r=>({...r,...r.markets[key]})),"logLoss")},rpsInterval:key==="total"?pairedInterval(paired.map(r=>({...r,...r.markets[key]})),"rps"):null,excludedIncomplete:rows.length-valid.length};
 }
 return{sampleSize:rows.length,pairedSampleSize:pairs.length,excludedUnpaired:rows.length-pairs.length,champion,challenger,market,markets,challengerComparison:{sampleSize:triples.length,champion:summarizeProbability(triples.map(r=>r.markets.had.model)),challenger,market:summarizeProbability(triples.map(r=>r.markets.had.market))},brierInterval:pairedInterval(pairs.map(r=>({...r,...r.markets.had}))),logLossInterval:pairedInterval(pairs.map(r=>({...r,...r.markets.had})),"logLoss")};
}
function foldValidation(rows){
 const eligible=rows.filter(r=>r.markets.had.model&&r.markets.had.market&&r.challenger),foldSize=Math.floor(eligible.length/4),items=[];
 if(foldSize>=5)for(let i=0;i<4;i++){const part=eligible.slice(i*foldSize,i===3?undefined:(i+1)*foldSize),m=evaluateWindow(part).challengerComparison;items.push({index:i+1,sampleSize:part.length,challengerBrier:m.challenger.brier,championBrier:m.champion.brier,marketBrier:m.market.brier,win:m.challenger.brier<Math.min(m.champion.brier,m.market.brier)});}
 return{sampleSize:eligible.length,folds:items.length,wins:items.filter(r=>r.win).length,items,method:"chronological-scoring-blocks-not-refitted-folds"};
}
/** Same fixture/version, actual pre-target data only; cash is scored separately. */
export function comparePredictionSlots(input){
 const groups=new Map(),excluded=[],conflicts=new Set();
 for(const row of input||[]){
  const slot=row.scheduledAt?probabilitySlotTime(row):String(row.scheduledTime||"");
  if(!["17:00","21:00"].includes(slot))continue;
  const target=Date.parse(`${row.salesDate}T${slot}:00+08:00`),capture=Date.parse(row.capturedAt||""),kickoff=Date.parse(row.kickoffAt||"");
  const times=[row.capturedAt,row.completedAt,row.persistedAt,row.aiCompletedAt,row.predictionGeneratedAt,row.modelInput?.decisionAt,row.modelInput?.official?.fetchedAt,row.sourceFetchedAt].filter(Boolean).map(v=>Date.parse(v));
  const at=times.length?Math.max(...times):NaN,key=`${row.salesDate}|${row.officialMatchId||""}`;
  let reason="";
  if(row.includedInStrictEvaluation===false||row.recovered)reason="unverified-completion";
  else if(row.resultConflict)reason="conflicting-official-result";
  else if(!row.officialMatchId||!/^\d{4}-\d{2}-\d{2}$/.test(row.salesDate||""))reason="missing-identity";
  else if(!Number.isFinite(target)||!Number.isFinite(capture)||!Number.isFinite(kickoff)||!Number.isFinite(at))reason="missing-time";
  else if(at>=kickoff)reason="not-pre-match";
  else if(at>target)reason="after-slot-target";
  else if(capture<target-15*60000)reason="outside-slot-window";
  else if(!row.baseModelVersion||!row.calibrationVersion)reason="unknown-version";
  if(reason){excluded.push({key,slot,reason});continue;}
  const version=`${row.baseModelVersion}|${row.calibrationVersion}`,groupKey=`${key}|${version}|${slot}`;
  const candidate=assessed({...row,decisionTargetAt:new Date(target).toISOString()}),previous=groups.get(groupKey);
  if(!candidate.baseline?.had){excluded.push({key,slot,reason:"missing-frozen-official-input"});continue;}
  const fingerprint=r=>JSON.stringify([r.modelHad,r.scoreDistribution,r.hhadProbabilities,r.totalGoalProbabilities,r.halfFullProbabilities,r.modelInput]);
  if(previous&&previous.at===at&&fingerprint(previous.row)!==fingerprint(candidate)){conflicts.add(groupKey);excluded.push({key,slot,reason:"conflicting-probability-record"});}
  if(!previous||previous.at<at)groups.set(groupKey,{key,slot,version,at,row:candidate});
 }
 const pairs=new Map();
 for(const [groupKey,record] of groups){if(conflicts.has(groupKey))continue;const key=`${record.key}|${record.version}`;if(!pairs.has(key))pairs.set(key,{});pairs.get(key)[record.slot]=record;}
 const versions=new Map();
 for(const [key,sides] of pairs){const early=sides["17:00"],late=sides["21:00"];
  if(!early||!late){excluded.push({key,slot:early?"21:00":"17:00",reason:"missing-same-version-side"});continue;}
  if(!early.row.actualHad||!late.row.actualHad){excluded.push({key,reason:"awaiting-result"});continue;}
  if(early.row.fullScore!==late.row.fullScore||Date.parse(early.row.kickoffAt)!==Date.parse(late.row.kickoffAt)){excluded.push({key,reason:"conflicting-fixture-or-result"});continue;}
  if(!versions.has(early.version))versions.set(early.version,[]);
  versions.get(early.version).push({key,salesDate:early.row.salesDate,early:early.row,late:late.row});
 }
 const strata=[...versions].map(([version,rows])=>({version,commonFixtures:rows.length,markets:Object.fromEntries(Object.keys(labels).map(market=>{
  const comparable=rows.filter(r=>{
   let reason="";
   if(market==="hhad"&&(r.early.baseline?.handicap!==r.late.baseline?.handicap))reason="market-contract-mismatch";
   else if(market==="halfFull"&&r.early.halfScore!==r.late.halfScore)reason="conflicting-half-result";
   else if(!r.early.markets[market].model||!r.late.markets[market].model)reason=market==="halfFull"&&(!r.early.halfScore||!r.late.halfScore)?"missing-half-result":"incomplete-distribution-or-result";
   else if(r.early.markets[market].model.index!==r.late.markets[market].model.index)reason="market-result-mismatch";
   if(reason)excluded.push({key:r.key,market,reason});
   return !reason;
  });
  const observations=comparable.map(r=>({...r,model:r.late.markets[market].model,market:r.early.markets[market].model}));
  return [market,{sampleSize:comparable.length,early:summarizeProbability(comparable.map(r=>r.early.markets[market].model)),late:summarizeProbability(comparable.map(r=>r.late.markets[market].model)),brierInterval:pairedInterval(observations),logLossInterval:pairedInterval(observations,"logLoss"),rpsInterval:market==="total"?pairedInterval(observations,"rps"):null}];
 }))}));
 return {policy:"same-fixture-version-actual-pre-slot-v1",strata,excluded,commonFixtures:strata.reduce((n,s)=>n+s.commonFixtures,0),isCashComparison:false};
}
/** @param {Array<any>} input @param {{fixtureUniverse?:Array<any>,now?:number}} options */
export function buildModelEvaluation(input,{fixtureUniverse=[],now=Date.now()}={}){
 const originals=[...(input||[])],selection=selectDecisionObservations(originals),selected=selection.rows.map(assessed),settled=selected.filter(r=>r.actualHad),windows={all:evaluateWindow(settled),recent100:evaluateWindow(settled.slice(-100)),recent50:evaluateWindow(settled.slice(-50))};
 const key=r=>String(r.officialMatchId?r.salesDate+"|"+r.officialMatchId:r.key||r.matchKey||""),universe=new Map();for(const r of [...fixtureUniverse,...originals])if(key(r)&&!universe.has(key(r)))universe.set(key(r),r);
 const captured=new Set(originals.map(key)),expected=universe.size,ratio=n=>expected?n/expected:0,due=[...universe.values()].filter(r=>Date.parse(r.kickoffAt||"")+3*3600000<=now),resolved=new Set(originals.filter(r=>scoreParts(r.fullScore).length===2).map(key)),exclusionCounts={};selection.excluded.forEach(r=>exclusionCounts[r.reason]=(exclusionCounts[r.reason]||0)+1);
 const dataHealth={denominatorScope:fixtureUniverse.length?"saved-official-fixture-manifests":"archived-fixtures",expectedFixtures:expected,capturedFixtures:[...universe.keys()].filter(k=>captured.has(k)).length,decisionEligibleFixtures:selected.length,verifiedResultFixtures:resolved.size,pendingResultFixtures:expected-due.length,missingDueResults:due.filter(r=>!resolved.has(key(r))).length,excludedByReason:exclusionCounts,officialIdCoverage:ratio([...universe.values()].filter(r=>r.officialMatchId).length),kickoffCoverage:ratio([...universe.values()].filter(r=>Number.isFinite(Date.parse(r.kickoffAt||""))).length),marketCoverage:ratio(selected.filter(r=>r.baseline?.had).length),resultCoverage:due.length?due.filter(r=>resolved.has(key(r))).length/due.length:null,intelligenceCoverage:ratio(selected.filter(r=>(r.intelligenceCoverage||0)>0).length),completeCoverage:ratio(selected.filter(r=>Object.values(r.vectors).every(Boolean)).length)};
 const groups=new Map();settled.forEach(r=>groups.set(r.league||"其他联赛",[...(groups.get(r.league||"其他联赛")||[]),r]));
 const leagues=[...groups].map(([name,rows])=>{const metrics=evaluateWindow(rows);return{name,...metrics,underpowered:metrics.pairedSampleSize<20,deltaBrier:metrics.brierInterval.delta};}).sort((a,b)=>b.sampleSize-a.sampleSize);
 const confidenceBands=[{name:"<35%",min:0,max:.35},{name:"35–50%",min:.35,max:.5},{name:">50%",min:.5,max:1.01}].map(b=>({name:b.name,...evaluateWindow(settled.filter(r=>{const vector=r.markets.had.model?.vector;if(!vector)return false;const top=Math.max(...vector);return top>=b.min&&top<b.max;}))}));
 const leadTimeBands=[{name:"≥6小时",min:6,max:Infinity},{name:"2–6小时",min:2,max:6},{name:"<2小时",min:0,max:2}].map(b=>({name:b.name,...evaluateWindow(settled.filter(r=>{const h=(Date.parse(r.kickoffAt)-Date.parse(r.informationAvailableAt))/3600000;return h>=b.min&&h<b.max;}))}));
 const errors=settled.map(r=>({...errorFor(r),key:r.key,id:r.id,league:r.league,home:r.home,away:r.away,actual:r.actualHad})),errorSummary=[...new Set(errors.map(r=>r.code))].map(code=>{const items=errors.filter(r=>r.code===code);return{code,label:items[0].label,trainable:false,count:items.length,rate:items.length/settled.length};});
 const comparison=windows.all.challengerComparison,validation=foldValidation(settled),{champion,challenger,market}=comparison;
 const gates=[{key:"raw-replay",label:"冻结候选的原始输入重放与未来样本证明",passed:false,value:"存档概率诊断，不代替模型签发"},
 {key:"sample",label:"同场同刻可比较样本 ≥ 100",passed:comparison.sampleSize>=100,value:comparison.sampleSize+"/100"},
 {key:"folds",label:"4个时间区块至少3个领先（非重训练验证）",passed:validation.folds>=4&&validation.wins>=3,value:validation.wins+"/"+(validation.folds||4)},
 {key:"brier",label:"Brier 改善至少0.005",passed:comparison.sampleSize>0&&challenger.brier<=Math.min(champion.brier,market.brier)-.005,value:comparison.sampleSize?(challenger.brier-Math.min(champion.brier,market.brier)).toFixed(3):"无样本"},
 {key:"logloss",label:"Log Loss 不劣于基线",passed:comparison.sampleSize>0&&challenger.logLoss<=Math.min(champion.logLoss,market.logLoss),value:comparison.sampleSize?challenger.logLoss.toFixed(3):"无样本"},
 {key:"calibration",label:"概率校准误差更低",passed:comparison.sampleSize>0&&challenger.ece<Math.min(champion.ece,market.ece),value:comparison.sampleSize?(challenger.ece*100).toFixed(1)+"%":"无样本"},
 {key:"data",label:"归档范围内固定决策采集覆盖 ≥ 95%",passed:ratio(selected.length)>=.95,value:(ratio(selected.length)*100).toFixed(1)+"%"}];
 const recent=windows.recent50.brierInterval,triggered=recent.sampleSize>=20&&recent.delta>.01;
 return{generatedAt:new Date(now).toISOString(),sampleSize:settled.length,slotComparison:comparePredictionSlots(originals),evaluationMode:"archived-probability-diagnostics",decisionPolicy:selection.policy,windows,segments:{leagues,confidenceBands,leadTimeBands},errors:{items:errors,summary:errorSummary},dataHealth,promotion:{status:comparison.sampleSize?"shadow_validation":"insufficient_challenger_data",eligible:false,gates,validation,alignedComparison:comparison},rollback:{active:triggered,threshold:.01,recentDelta:recent.delta,triggered},excluded:selection.excluded};
}
export const MODEL_PROMOTION_POLICY={minimumFutureSample:100,minimumWinningFolds:3,foldCount:4,minimumBrierGain:.005,minimumCompleteness:.95,rollbackBrierDegradation:.01,requiresFrozenRawReplay:true};
