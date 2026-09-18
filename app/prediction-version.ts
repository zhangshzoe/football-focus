/* eslint-disable @typescript-eslint/no-explicit-any */
export const BASE_MODEL_VERSION="multi-market-poisson-v5-dc-shadow";
export const FUSION_MODEL_VERSION="evidence-and-out-of-sample-gated-v3";
export const EVIDENCE_MAX_AGE_MS=48*60*60*1000;
const INTELLIGENCE_MAX_WEIGHT=.4;

export type EvidenceRecord={type:string;sourceUrl:string;observedAt:string;summary?:string};

export function stableHash(value:unknown){
 const text=JSON.stringify(value,Object.keys((value&&typeof value==="object"?value:{}) as object).sort());let hash=2166136261;
 for(let index=0;index<text.length;index++){hash^=text.charCodeAt(index);hash=Math.imul(hash,16777619)}
 return (hash>>>0).toString(36);
}

function canonical(value:any):any{
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
 return value;
}
export function predictionHash(value:unknown){const text=JSON.stringify(canonical(value));let hash=2166136261;for(let index=0;index<text.length;index++){hash^=text.charCodeAt(index);hash=Math.imul(hash,16777619)}return(hash>>>0).toString(36)}

export function createBasePredictionVersion(reports:any[],calibrationVersion:string,generatedAt:string){
 const inputSnapshotId=`input-${predictionHash(reports.map(report=>({officialMatchId:report.officialMatchId,salesDate:report.salesDate,companies:report.companies,officialOdds:report.marketSignal?.officialOdds,officialHhadOdds:report.marketSignal?.officialHhadOdds,handicap:report.marketSignal?.officialHandicap})) )}`;
 const predictionId=`pred-${predictionHash({inputSnapshotId,baseModelVersion:BASE_MODEL_VERSION,calibrationVersion,generatedAt})}`;
 return{predictionId,inputSnapshotId,baseModelVersion:BASE_MODEL_VERSION,calibrationVersion,aiReviewVersion:null,generatedAt};
}

export function validEvidenceRecords(value:unknown,generatedAt:string):EvidenceRecord[]{
 const now=new Date(generatedAt).getTime();if(!Number.isFinite(now)||!Array.isArray(value))return[];
 return value.filter((item:any)=>{const at=new Date(item?.observedAt).getTime();return typeof item?.type==="string"&&item.type.trim()&&/^https?:\/\//.test(String(item?.sourceUrl||""))&&Number.isFinite(at)&&at<=now+5*60*1000&&now-at<=EVIDENCE_MAX_AGE_MS}).map((item:any)=>({type:item.type.trim(),sourceUrl:String(item.sourceUrl),observedAt:new Date(item.observedAt).toISOString(),summary:String(item.summary||"")}));
}

const cleanPoints=(points:any[])=>(Array.isArray(points)?points:[]).map(point=>({score:String(point?.score||""),probability:Math.max(0,Number(point?.probability)||0)})).filter(point=>/^\d+:\d+$/.test(point.score));
const normalized=(points:any[])=>{const clean=cleanPoints(points),sum=clean.reduce((total,point)=>total+point.probability,0);return sum>0?clean.map(point=>({...point,probability:point.probability/sum*100})):[]};

export function fuseFullScoreDistribution(basePoints:any[],intelligencePoints:any[],coverage:number,intelligenceWeightMultiplier=0){
 const base=normalized(basePoints);if(!base.length)return[];
 const safeCoverage=Math.max(0,Math.min(100,Number(coverage)||0)),validatedMultiplier=Math.max(0,Math.min(1,Number(intelligenceWeightMultiplier)||0)),weight=INTELLIGENCE_MAX_WEIGHT*safeCoverage/100*validatedMultiplier;
 if(weight<=0)return base;
 const intelRaw=cleanPoints(intelligencePoints),rawMass=intelRaw.reduce((sum,point)=>sum+point.probability,0),scale=rawMass>95?95/rawMass:1,intelProvided=intelRaw.map(point=>({...point,probability:point.probability*scale})),intelMap=new Map(intelProvided.map(point=>[point.score,point.probability]));
 if(!intelMap.size)return base;
 const providedScores=new Set(intelMap.keys()),providedMass=intelProvided.reduce((sum,point)=>sum+point.probability,0),unlistedBase=base.filter(point=>!providedScores.has(point.score)),unlistedBaseMass=unlistedBase.reduce((sum,point)=>sum+point.probability,0);
 const intelligenceFull=base.map(point=>({score:point.score,probability:intelMap.has(point.score)?intelMap.get(point.score)||0:unlistedBaseMass>0?point.probability/unlistedBaseMass*(100-providedMass):0}));
 return base.map(point=>({score:point.score,probability:point.probability*(1-weight)+(intelligenceFull.find(item=>item.score===point.score)?.probability||0)*weight})).sort((a,b)=>b.probability-a.probability);
}

export function deriveMarkets(distribution:any[],handicapValue:unknown){
 const points=normalized(distribution),had=[0,0,0],hhad=[0,0,0],goals=new Array(8).fill(0),text=String(handicapValue??"").trim(),handicap=text===""?null:Number(text);
 for(const point of points){const [home,away]=point.score.split(":").map(Number),probability=point.probability;had[home>away?0:home===away?1:2]+=probability;goals[Math.min(7,home+away)]+=probability;if(handicap!==null&&Number.isFinite(handicap)){const adjusted=home-away+handicap;hhad[adjusted>0?0:adjusted===0?1:2]+=probability}}
 return{hadProbabilities:["胜","平","负"].map((score,index)=>({score,probability:had[index]})),hhadProbabilities:handicap===null?undefined:["让胜","让平","让负"].map((score,index)=>({score,probability:hhad[index]})),totalGoalProbabilities:["0球","1球","2球","3球","4球","5球","6球","7+球"].map((score,index)=>({score,probability:goals[index]}))};
}

export function applyAiReviewVersion(baseVersion:any,reports:any[],reviews:any[],provider:string,model:string,generatedAt:string,intelligenceWeightMultiplier=0){
 const safeMultiplier=Math.max(0,Math.min(1,Number(intelligenceWeightMultiplier)||0));
 const updated=reports.map(report=>{const review=reviews.find(item=>String(item.id)===String(report.id)),records=validEvidenceRecords(report.intelligenceEvidence?.records,generatedAt),verifiedTypes=new Set((Array.isArray(review?.verifiedIntelItems)?review.verifiedIntelItems:[]).map((item:any)=>typeof item==="string"?item:String(item?.type||""))),accepted=records.filter(record=>verifiedTypes.has(record.type)),coverage=Math.min(100,accepted.length/7*100),appliedIntelligenceWeight=INTELLIGENCE_MAX_WEIGHT*coverage/100*safeMultiplier,baseDistribution=report.fullScoreDistribution||report.scores,full=fuseFullScoreDistribution(baseDistribution,review?.scores||[],coverage,safeMultiplier),shadowFullScoreDistribution=fuseFullScoreDistribution(baseDistribution,review?.scores||[],coverage,1),derived=deriveMarkets(full,report.marketSignal?.officialHandicap),shadowDerived=deriveMarkets(shadowFullScoreDistribution,report.marketSignal?.officialHandicap);
  return{...report,fullScoreDistribution:full,scores:full.slice(0,4),oddsScores:report.fullScoreDistribution||report.oddsScores||report.scores,intelligenceScores:coverage>0?normalized(review?.scores||[]):undefined,combinedScores:full.slice(0,4),shadowFullScoreDistribution,shadowHadProbabilities:shadowDerived.hadProbabilities,intelligenceCoverage:coverage,appliedIntelligenceWeight,intelligenceEvidence:{records:accepted},aiSummary:String(review?.summary||""),aiRisk:String(review?.risk||""),probabilities:{home:derived.hadProbabilities[0].probability,draw:derived.hadProbabilities[1].probability,away:derived.hadProbabilities[2].probability},marketSignal:{...report.marketSignal,modeledHhad:derived.hhadProbabilities?.map(item=>item.probability)||[],modeledTotalGoals:derived.totalGoalProbabilities.map(item=>item.probability)},hadProbabilities:derived.hadProbabilities,hhadProbabilities:derived.hhadProbabilities,totalGoalProbabilities:derived.totalGoalProbabilities};
 });
 const hasNumericalEvidence=updated.some(report=>(report.appliedIntelligenceWeight||0)>0),aiReviewVersion=`${provider}:${model||"default"}:${predictionHash(reviews)}`,predictionId=hasNumericalEvidence?`pred-${predictionHash({parent:baseVersion.predictionId,aiReviewVersion,distributions:updated.map(report=>report.fullScoreDistribution)})}`:baseVersion.predictionId;
 const versionGeneratedAt=hasNumericalEvidence?generatedAt:baseVersion.generatedAt,version={...baseVersion,predictionId,aiReviewVersion,reviewForPredictionId:baseVersion.predictionId,parentPredictionId:hasNumericalEvidence?baseVersion.predictionId:null,generatedAt:versionGeneratedAt,aiReviewedAt:generatedAt};
 return{version,reports:updated.map(report=>({...report,predictionId,inputSnapshotId:version.inputSnapshotId,baseModelVersion:version.baseModelVersion,calibrationVersion:version.calibrationVersion,predictionGeneratedAt:versionGeneratedAt}))};
}
