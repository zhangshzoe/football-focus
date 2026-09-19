import {createHash} from "node:crypto";
import {readFile,readdir} from "node:fs/promises";
import {join} from "node:path";
import type {CalibrationBucket,ModelCalibrationProfile,ScorePoint} from "./prediction-config";
import {decisionTargetAt} from "./snapshot-decision-policy.js";

export type CalibrationObservation={matchKey:string;league:string;kickoffAt:string;capturedAt:string;modelProbabilities:ScorePoint[];baseModelProbabilities?:ScorePoint[];intelligenceCandidateProbabilities?:ScorePoint[];marketProbabilities:ScorePoint[];actual:"胜"|"平"|"负";totalGoals:number;halfGoals?:number;homeGoals?:number;awayGoals?:number;expectedHomeGoals?:number;expectedAwayGoals?:number;intelligenceCoverage?:number};
type ProbabilityMetrics={brier:number;logLoss:number;sampleSize:number;coverage:number;buckets:Array<{range:string;count:number;meanProbability:number;observedRate:number}>};
const directory=join(process.cwd(),"data","model-calibration");
const bundledProfiles=import.meta.glob<ModelCalibrationProfile>("../data/model-calibration/cal-*.json",{eager:true,import:"default"});
let runtimeProfile:ModelCalibrationProfile|null=null;
const labels=["胜","平","负"];
const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value));
const normalized=(points:ScorePoint[])=>{const values=labels.map(label=>Math.max(.000001,Number(points.find(point=>point.score===label)?.probability||0)/100)),sum=values.reduce((a,b)=>a+b,0);return values.map(value=>value/sum)};
const tempered=(values:number[],temperature:number)=>{const scaled=values.map(value=>Math.pow(Math.max(.000001,value),1/temperature)),sum=scaled.reduce((a,b)=>a+b,0);return scaled.map(value=>value/sum)};
const scoreRows=(rows:CalibrationObservation[],selector:(row:CalibrationObservation)=>number[],coverage:number):ProbabilityMetrics=>{
 const buckets=Array.from({length:5},(_,index)=>({range:`${index*20}–${(index+1)*20}%`,count:0,sumProbability:0,hits:0}));let brier=0,logLoss=0;
 rows.forEach(row=>{const probabilities=selector(row),actualIndex=labels.indexOf(row.actual);brier+=probabilities.reduce((sum,value,index)=>sum+(value-(index===actualIndex?1:0))**2,0);logLoss-=Math.log(Math.max(.000001,probabilities[actualIndex]));probabilities.forEach((value,index)=>{const bucket=buckets[Math.min(4,Math.floor(value*5))];bucket.count++;bucket.sumProbability+=value;if(index===actualIndex)bucket.hits++;});});
 return{brier:rows.length?brier/rows.length:0,logLoss:rows.length?logLoss/rows.length:0,sampleSize:rows.length,coverage,buckets:buckets.map(bucket=>({range:bucket.range,count:bucket.count,meanProbability:bucket.count?bucket.sumProbability/bucket.count:0,observedRate:bucket.count?bucket.hits/bucket.count:0}))};
};
const expectedCalibrationError=(metrics:ProbabilityMetrics)=>{const total=metrics.buckets.reduce((sum,item)=>sum+item.count,0);return total?metrics.buckets.reduce((sum,item)=>sum+item.count*Math.abs(item.meanProbability-item.observedRate),0)/total:0};
const bucket=(rows:CalibrationObservation[]):CalibrationBucket=>{const totals=rows.map(row=>row.totalGoals).filter(Number.isFinite),mean=totals.length?totals.reduce((a,b)=>a+b,0)/totals.length:2.6,variance=totals.length>1?totals.reduce((sum,value)=>sum+(value-mean)**2,0)/(totals.length-1):mean,half=rows.map(row=>row.halfGoals).filter((value):value is number=>Number.isFinite(value)),fullTotal=totals.reduce((a,b)=>a+b,0),halfTotal=half.reduce((a,b)=>a+b,0);return{sampleSize:rows.length,meanTotalGoals:mean,goalDispersion:mean?clamp(variance/mean,.85,1.6):1,firstHalfGoalShare:fullTotal?clamp(halfTotal/fullTotal,.35,.55):.45,lowScoreRho:fitLowScoreRho(rows)}};
const profileHash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0,12);

const poisson=(lambda:number,goals:number)=>{let factorial=1;for(let index=2;index<=goals;index++)factorial*=index;return Math.exp(-lambda)*Math.pow(lambda,goals)/factorial};
const dixonColesTau=(home:number,away:number,homeLambda:number,awayLambda:number,rho:number)=>{
 if(home===0&&away===0)return 1-homeLambda*awayLambda*rho;
 if(home===0&&away===1)return 1+homeLambda*rho;
 if(home===1&&away===0)return 1+awayLambda*rho;
 if(home===1&&away===1)return 1-rho;
 return 1;
};
function fitLowScoreRho(rows:CalibrationObservation[]){
 const usable=rows.filter(row=>Number.isInteger(row.homeGoals)&&Number.isInteger(row.awayGoals)&&numberInRange(row.expectedHomeGoals,.1,5)&&numberInRange(row.expectedAwayGoals,.1,5));
 if(usable.length<20)return 0;
 const candidates=Array.from({length:31},(_,index)=>-.15+index*.01);
 const loss=(rho:number)=>usable.reduce((sum,row)=>{
  const home=row.homeGoals!,away=row.awayGoals!,homeLambda=row.expectedHomeGoals!,awayLambda=row.expectedAwayGoals!,tau=dixonColesTau(home,away,homeLambda,awayLambda,rho);
  return sum-Math.log(Math.max(1e-8,poisson(homeLambda,home)*poisson(awayLambda,away)*Math.max(.05,tau)));
 },0);
 return Number(candidates.reduce((best,current)=>loss(current)<loss(best)?current:best,0).toFixed(2));
}
const numberInRange=(value:unknown,min:number,max:number)=>Number.isFinite(Number(value))&&Number(value)>=min&&Number(value)<=max;

export function buildCalibrationEvaluation(input:CalibrationObservation[]):ModelCalibrationProfile{
 const valid=input.filter(row=>row.matchKey&&Number.isFinite(Date.parse(row.kickoffAt))&&Number.isFinite(Date.parse(row.capturedAt))&&row.modelProbabilities?.length===3&&row.marketProbabilities?.length===3&&labels.includes(row.actual));
 const grouped=new Map<string,CalibrationObservation[]>();valid.forEach(row=>grouped.set(row.matchKey,[...(grouped.get(row.matchKey)||[]),row]));
 const selected:Array<CalibrationObservation>=[];grouped.forEach(rows=>{const salesDate=rows[0].matchKey.match(/^\d{4}-\d{2}-\d{2}/)?.[0]||rows[0].kickoffAt.slice(0,10),decisionAt=Date.parse(decisionTargetAt(salesDate,rows[0].kickoffAt)||""),candidate=rows.filter(row=>Number.isFinite(decisionAt)&&Date.parse(row.capturedAt)<=decisionAt).sort((a,b)=>Date.parse(b.capturedAt)-Date.parse(a.capturedAt))[0];if(candidate)selected.push(candidate)});selected.sort((a,b)=>Date.parse(a.kickoffAt)-Date.parse(b.kickoffAt));
 const trainEnd=Math.floor(selected.length*.6),calibrationEnd=Math.floor(selected.length*.8),training=selected.slice(0,trainEnd),calibration=selected.slice(trainEnd,calibrationEnd),test=selected.slice(calibrationEnd),coverage=grouped.size?selected.length/grouped.size:0;
 const candidates=Array.from({length:37},(_,index)=>.7+index*.05),calibrationBrier=(temperature:number)=>scoreRows(calibration,row=>tempered(normalized(row.modelProbabilities),temperature),coverage).brier,temperature=calibration.length>=6?candidates.reduce((best,current)=>calibrationBrier(current)<calibrationBrier(best)?current:best,1):1;
 const fittingRaw=scoreRows(calibration,row=>normalized(row.modelProbabilities),coverage),fittingCalibrated=scoreRows(calibration,row=>tempered(normalized(row.modelProbabilities),temperature),coverage),testRaw=scoreRows(test,row=>normalized(row.modelProbabilities),coverage),testCalibrated=scoreRows(test,row=>tempered(normalized(row.modelProbabilities),temperature),coverage),testMarket=scoreRows(test,row=>normalized(row.marketProbabilities),coverage);
 const rollingRows:CalibrationObservation[]=[],rollingMarketRows:CalibrationObservation[]=[];let folds=0,foldWins=0;const window=Math.max(2,Math.floor(selected.length*.1));
 for(let origin=Math.floor(selected.length*.5);origin+window<=selected.length;origin+=window){const foldCalibration=selected.slice(Math.max(0,origin-window),origin),foldTest=selected.slice(origin,origin+window);if(foldCalibration.length<2||!foldTest.length)continue;const foldTemperature=candidates.reduce((best,current)=>scoreRows(foldCalibration,row=>tempered(normalized(row.modelProbabilities),current),coverage).brier<scoreRows(foldCalibration,row=>tempered(normalized(row.modelProbabilities),best),coverage).brier?current:best,1),foldModel=scoreRows(foldTest,row=>tempered(normalized(row.modelProbabilities),foldTemperature),coverage),foldMarket=scoreRows(foldTest,row=>normalized(row.marketProbabilities),coverage);if(foldModel.brier<foldMarket.brier)foldWins++;foldTest.forEach(row=>{rollingRows.push({...row,modelProbabilities:labels.map((score,index)=>({score,probability:tempered(normalized(row.modelProbabilities),foldTemperature)[index]*100}))});rollingMarketRows.push(row)});folds++;}
 const rollingCalibrated=scoreRows(rollingRows,row=>normalized(row.modelProbabilities),coverage),rollingMarket=scoreRows(rollingMarketRows,row=>normalized(row.marketProbabilities),coverage);
 const leagues:Record<string,CalibrationBucket>={};Array.from(new Set(training.map(row=>row.league).filter(Boolean))).forEach(league=>{const rows=training.filter(row=>row.league===league);if(rows.length>=5)leagues[league]=bucket(rows)});
 const intelligenceTest=test.filter(row=>(row.intelligenceCoverage||0)>0&&row.baseModelProbabilities?.length===3&&row.intelligenceCandidateProbabilities?.length===3),intelligenceBase=scoreRows(intelligenceTest,row=>normalized(row.baseModelProbabilities||[]),coverage),intelligenceFused=scoreRows(intelligenceTest,row=>normalized(row.intelligenceCandidateProbabilities||[]),coverage),intelligenceDelta=intelligenceFused.brier-intelligenceBase.brier,intelligenceStatus=intelligenceTest.length<20?"insufficient_data":intelligenceDelta<=-.005?"validated_gain":"no_gain",intelligenceWeightMultiplier=intelligenceStatus==="validated_gain"?1:0;
 const lowScoreRho=fitLowScoreRho(training);
 const deterministic={decisionPolicy:"latest_not_after_official_target_v1",splitPolicy:"chronological_60_20_20_v1",temperature:Number(temperature.toFixed(2)),lowScoreRho,intelligenceWeightMultiplier,trainingKeys:training.map(row=>row.matchKey),calibrationKeys:calibration.map(row=>row.matchKey),testKeys:test.map(row=>row.matchKey)};
 const promotionGates=[
  {key:"sample",label:"未来独立样本 ≥ 100",passed:test.length>=100,value:`${test.length}/100`},
  {key:"folds",label:"滚动验证至少 4 折且 3 折领先",passed:folds>=4&&foldWins>=3,value:`${foldWins}/${folds}`},
  {key:"brier",label:"未来测试 Brier 至少优于市场 0.005",passed:testCalibrated.brier<=testMarket.brier-.005,value:(testCalibrated.brier-testMarket.brier).toFixed(3)},
  {key:"logloss",label:"未来测试 Log Loss 不劣于市场",passed:testCalibrated.logLoss<=testMarket.logLoss,value:`${testCalibrated.logLoss.toFixed(3)} / ${testMarket.logLoss.toFixed(3)}`},
  {key:"calibration",label:"未来测试概率校准误差更低",passed:expectedCalibrationError(testCalibrated)<expectedCalibrationError(testMarket),value:`${(expectedCalibrationError(testCalibrated)*100).toFixed(1)}% / ${(expectedCalibrationError(testMarket)*100).toFixed(1)}%`},
  {key:"coverage",label:"正式决策样本覆盖率 ≥ 95%",passed:coverage>=.95,value:`${(coverage*100).toFixed(1)}%`},
 ];
 const profileId=`cal-${profileHash(deterministic)}`,status=promotionGates.every(gate=>gate.passed)?"validated":"insufficient_data";
 const global={...bucket(training),lowScoreRho};
 return{version:3,profileId,status,generatedAt:new Date().toISOString(),decisionPolicy:deterministic.decisionPolicy,splitPolicy:deterministic.splitPolicy,forecastSampleSize:selected.length,uniqueMatchCount:grouped.size,coverage,trainingSampleSize:training.length,calibrationSampleSize:calibration.length,testSampleSize:test.length,probabilityTemperature:Number(temperature.toFixed(2)),intelligenceWeightMultiplier,intelligenceValidation:{sampleSize:intelligenceTest.length,baseBrier:intelligenceBase.brier,fusedBrier:intelligenceFused.brier,delta:intelligenceDelta,status:intelligenceStatus},rawBrier:fittingRaw.brier,calibratedBrier:fittingCalibrated.brier,fitting:{raw:fittingRaw,calibrated:fittingCalibrated},futureTest:{raw:testRaw,calibrated:testCalibrated,marketBaseline:testMarket},rollingValidation:{folds,wins:foldWins,sampleSize:rollingRows.length,calibrated:rollingCalibrated,marketBaseline:rollingMarket},promotionGates,simulationReturn:null,global,leagues};
}

export async function getPublishedCalibration(){
 if(runtimeProfile)return runtimeProfile;const profiles:ModelCalibrationProfile[]=[...Object.values(bundledProfiles)];
 try{for(const name of (await readdir(directory)).filter(name=>/^cal-.*\.json$/.test(name))){try{profiles.push(JSON.parse(await readFile(join(directory,name),"utf8")) as ModelCalibrationProfile)}catch{/* 忽略损坏版本。 */}}}catch{/* 无磁盘目录时使用打包版本。 */}
 runtimeProfile=profiles.filter(profile=>profile.status==="validated").sort((a,b)=>String(b.generatedAt).localeCompare(String(a.generatedAt)))[0]||null;return runtimeProfile;
}

export async function publishCalibration(input:CalibrationObservation[]){
 const evaluation=buildCalibrationEvaluation(input),published=await getPublishedCalibration();
 // 页面复盘只能生成候选评估，不能把同一批历史赛果自动写成正式参数。
 // 真正晋级需将通过全部门槛的候选作为新版本审阅、签发并随代码发布。
 return{evaluation,published,promoted:false,promotionCandidate:evaluation.status==="validated"};
}
