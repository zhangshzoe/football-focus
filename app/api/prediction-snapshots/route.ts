import {readdir,readFile} from "node:fs/promises";
import {join} from "node:path";
import {NextResponse} from "next/server";
import {selectOfficialDecisionRows} from "../../snapshot-decision-policy.js";
import {buildArchiveRecoverySnapshots} from "../../archive-recovery.js";
import recoveredResults from "../../../data/result-supplements/2026-09-23-24.json";
import {readCaptureAttempts} from "../../../scripts/read-capture-attempts.mjs";
import {snapshotOddsProjection,projectSnapshotOddsLayers} from "../../snapshot-probability-layers.js";
import {getCloudResearchStore} from "../../cloud-research-binding";
import {cloudCaptureReadModel} from "../../cloud-capture-read-model.js";
import {isProbabilitySlotSnapshot} from "../../slot-probability-observations.js";
import {purchaseHistorySnapshot,mergePurchaseHistorySnapshots} from "../../purchase-history-source.js";

export const dynamic="force-dynamic";

type RawReport={aiEvidenceSummary?:unknown;contextProof?:unknown;aiReviewMode?:string;modelInput?:any;modelParameters?:unknown;shadowGeneratedAt?:string;
 sourceFetchedAt?:string;marketTotalGoalProbabilities?:number[];dataQuality?:unknown;
 id?:string;officialMatchId?:string;salesDate?:string;kickoffAt?:string;homeTeamId?:string;awayTeamId?:string;homeTeamCode?:string;awayTeamCode?:string;officialMappingStatus?:string;marketEligibility?:Record<string,unknown>;league?:string;time?:string;matchDate?:string;home?:string;away?:string;matchStatus?:string;isMock?:boolean;sourceUpdatedAt?:string;
 predictionId?:string;inputSnapshotId?:string;baseModelVersion?:string;calibrationVersion?:string;predictionGeneratedAt?:string;fullScoreDistribution?:Array<{score?:string;probability?:number}>;shadowFullScoreDistribution?:Array<{score?:string;probability?:number}>;shadowHadProbabilities?:Array<{score?:string;probability?:number}>;scores?:Array<{score?:string;probability?:number}>;oddsScores?:Array<{score?:string;probability?:number}>;marketProbabilities?:number[];intelligenceScores?:Array<{score?:string;probability?:number}>;intelligenceCoverage?:number;appliedIntelligenceWeight?:number;aiSummary?:string;aiRisk?:string;probabilities?:{home?:number;draw?:number;away?:number};expectedGoals?:{home?:number;away?:number};
 layers?:{oddsBaseline?:{fullScoreDistribution?:Array<{score?:string;probability?:number}>;probabilities?:{home?:number;draw?:number;away?:number}};intelligenceOutput?:{scores?:Array<{score?:string;probability?:number}>;coverage?:number;summary?:string;risk?:string;evidence?:unknown[]};fusionOutput?:{fullScoreDistribution?:Array<{score?:string;probability?:number}>;probabilities?:{home?:number;draw?:number;away?:number};hhad?:number[];totalGoals?:number[];halfFull?:number[]}};inputHash?:string;parameters?:unknown;
 marketSignal?:{modeledHhad?:number[];modeledTotalGoals?:number[];modeledHalfFull?:number[];officialHandicap?:string;rawProbabilities?:number[]};consensus?:{agreement?:string};missingCompanies?:unknown[];companies?:unknown[];
};
type RawSnapshot={schemaVersion?:number;recordType?:string;snapshotId?:string;immutable?:boolean;predictionId?:string;version?:unknown;scheduledAt?:string;capturedAt?:string;upstreamUpdatedAt?:string;scheduledTime?:string;sourceFetchedAt?:string;decisionTiming?:string;reports?:RawReport[];aiProvider?:string;purchasePlans?:unknown;inputHash?:string;officialMatches?:unknown[]};
type Supplement={recordId?:string;kind?:"ai-review"|"purchase-plans"|"result-correction";baseSnapshotId?:string;inputPredictionId?:string;outputPredictionId?:string;createdAt?:string;aiCompletedAt?:string;decisionTiming?:string;includedInPreMatchEvaluation?:boolean;provider?:string;version?:unknown;reports?:RawReport[];plans?:unknown};
type RawPurchaseSnapshot={forecasts?:RawReport[];inputDecisionAt?:string;completedAt?:string;predictionVersion?:{baseModelVersion?:string;calibrationVersion?:string};recordType?:string;immutable?:boolean;snapshotId?:string;scheduledAt?:string;capturedAt?:string;sourceFetchedAt?:string;predictionId?:string;contentHash?:string;previousSnapshotId?:string;planSet?:{plans?:unknown[];[key:string]:unknown}};

const directory=join(process.cwd(),"data","prediction-snapshots");
const purchaseDirectory=join(process.cwd(),"data","purchase-plan-snapshots");
// 线上 Worker 只加载预先生成的紧凑索引。原始快照和 AI 补充文件仍完整保留在
// data/prediction-snapshots 供本地审计，但不得逐个 eager import 到 128MB Worker。
const bundledIndexFiles=import.meta.glob<{snapshots?:unknown[];resultCache?:Record<string,unknown>;purchasePlanSnapshots?:unknown[]}>("../../../data/generated-prediction-snapshot-index.json",{eager:true,import:"default"});
const toPurchaseSnapshot=(record:RawPurchaseSnapshot)=>{
 const base=purchaseHistorySnapshot(record);
 if(!base)return null;
 const target=Date.parse(record.scheduledAt||""),local=Number.isFinite(target)?new Date(target+8*3600000).toISOString():"";
 return {...base,evaluationSnapshot:record.forecasts?.length?toSnapshot({...record,reports:record.forecasts},local.slice(0,10)+"_"+local.slice(11,16).replace(":","")+".raw.json"):null};
};
async function readPurchaseSnapshotsFromDisk(){
 try{
  const names=(await readdir(purchaseDirectory)).filter(name=>name.endsWith(".json"));
  return (await Promise.all(names.map(async name=>{
   try{return toPurchaseSnapshot(JSON.parse(await readFile(join(purchaseDirectory,name),"utf8")) as RawPurchaseSnapshot)}catch{return null}
  }))).filter((record):record is NonNullable<ReturnType<typeof toPurchaseSnapshot>>=>record!==null);
 }catch{return [] as Array<NonNullable<ReturnType<typeof toPurchaseSnapshot>>>}
}
const labelFor=(slot:string)=>`${slot.slice(0,2)}:${slot.slice(2)}批次`;
const number=(value:unknown)=>Number.isFinite(Number(value))?Number(value):0;
// JSON encodes missing/invalid probability as null; evaluation rejects it.
const validProbability=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?value:NaN;
const withDerivedTotalGoals=<T extends {fullScore?:string;totalGoalsResult?:string}>(result:T)=>{
 if(result.totalGoalsResult)return result;
 const score=/^(\d{1,2}):(\d{1,2})$/.exec(String(result.fullScore||"").trim());
 if(!score)return result;
 const goals=Number(score[1])+Number(score[2]);
 return {...result,totalGoalsResult:goals>=7?"7+":String(goals),totalGoalsResultBasis:"derived_from_verified_full_score"};
};

function toSnapshot(raw:RawSnapshot,fileName:string,supplements:Supplement[]=[]){
 const matched=fileName.match(/^(\d{4}-\d{2}-\d{2})_((?:[01]\d|2[0-3])[0-5]\d)(?:\.raw)?\.json$/);
 if(!matched||!Array.isArray(raw.reports))return null;
 const [date,slot]=matched.slice(1);
 const snapshotId=raw.snapshotId||`${date}-${slot}`;
 const linked=supplements.filter(record=>record.baseSnapshotId===snapshotId).sort((a,b)=>String(a.createdAt||"").localeCompare(String(b.createdAt||"")));
 const ai=linked.filter(record=>record.kind==="ai-review"&&record.includedInPreMatchEvaluation===true&&Array.isArray(record.reports)).at(-1);
 const reports=ai?.reports||raw.reports;
 const plan=linked.filter(record=>record.kind==="purchase-plans"&&record.includedInPreMatchEvaluation===true).at(-1);
 const scheduledAt=String(raw.scheduledAt||`${date}T${slot.slice(0,2)}:${slot.slice(2)}:00+08:00`);
 return {
  snapshotId,immutable:raw.immutable===true,schemaVersion:raw.schemaVersion||1,predictionId:ai?.outputPredictionId||raw.predictionId,basePredictionId:raw.predictionId,version:ai?.version||raw.version,date,scheduledAt,capturedAt:String(raw.capturedAt||""),upstreamUpdatedAt:String(raw.upstreamUpdatedAt||raw.sourceFetchedAt||""),sourceFetchedAt:String(raw.sourceFetchedAt||raw.capturedAt||scheduledAt),aiCompletedAt:String(ai?.aiCompletedAt||""),decisionTiming:ai?.decisionTiming||raw.decisionTiming||"unknown",scheduleLabel:`${labelFor(slot).replace("批次","")} 计划批次，${raw.capturedAt?new Date(raw.capturedAt).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai",hour:"2-digit",minute:"2-digit",hour12:false}):"--:--"} 实际完成`,storageOrigin:"server",aiProvider:ai?.provider||raw.aiProvider||"",purchasePlans:plan?.plans||raw.purchasePlans,inputHash:raw.inputHash||"",supplements:linked.map(({reports,...record})=>({...record,hasReports:Boolean(reports?.length)})),
  fixtureUniverse:(raw.officialMatches||[]).map((match:any)=>({officialMatchId:String(match.officialMatchId||match.matchId||""),salesDate:match.salesDate||date,kickoffAt:match.kickoffAt||""})),matches:reports.filter(report=>report.id&&report.home&&report.away).map(report=>({
   aiEvidenceSummary:report.aiEvidenceSummary,aiReviewMode:report.aiReviewMode,contextProof:report.contextProof,modelInput:report.modelInput,modelParameters:report.modelParameters,shadowGeneratedAt:report.shadowGeneratedAt||ai?.aiCompletedAt,marketTotalGoalProbabilities:report.marketTotalGoalProbabilities,dataQuality:report.dataQuality,
   predictionId:String(report.predictionId||raw.predictionId||""),inputSnapshotId:String(report.inputSnapshotId||""),baseModelVersion:String(report.baseModelVersion||""),calibrationVersion:String(report.calibrationVersion||""),predictionGeneratedAt:String(report.predictionGeneratedAt||raw.capturedAt||""),fullScoreDistribution:(report.layers?.fusionOutput?.fullScoreDistribution||report.fullScoreDistribution||report.scores||[]).map(point=>({score:String(point.score||""),probability:validProbability(point.probability)})).filter(point=>point.score),expectedGoals:{home:number(report.expectedGoals?.home),away:number(report.expectedGoals?.away)},appliedIntelligenceWeight:number(report.appliedIntelligenceWeight),id:String(report.id),officialMatchId:String(report.officialMatchId||""),salesDate:String(report.salesDate||""),kickoffAt:String(report.kickoffAt||""),homeTeamId:String(report.homeTeamId||""),awayTeamId:String(report.awayTeamId||""),homeTeamCode:String(report.homeTeamCode||""),awayTeamCode:String(report.awayTeamCode||""),officialMappingStatus:String(report.officialMappingStatus||""),marketEligibility:report.marketEligibility,league:String(report.league||""),time:String(report.time||""),matchDate:String(report.matchDate||report.time||""),home:String(report.home),away:String(report.away),matchStatus:String(report.matchStatus||""),isMock:Boolean(report.isMock),
   ...snapshotOddsProjection(report),
   intelligenceScores:(report.layers?.intelligenceOutput?.scores||report.intelligenceScores||[]).map(point=>({score:String(point.score||""),probability:validProbability(point.probability)})).filter(point=>point.score),intelligenceCoverage:number(report.layers?.intelligenceOutput?.coverage??report.intelligenceCoverage),aiSummary:String(report.layers?.intelligenceOutput?.summary||report.aiSummary||""),aiRisk:String(report.layers?.intelligenceOutput?.risk||report.aiRisk||""),
   combinedScores:(report.layers?.fusionOutput?.fullScoreDistribution||report.fullScoreDistribution||report.scores||[]).map(point=>({score:String(point.score||""),probability:validProbability(point.probability)})).filter(point=>point.score),shadowFullScoreDistribution:(report.shadowFullScoreDistribution||[]).map(point=>({score:String(point.score||""),probability:validProbability(point.probability)})).filter(point=>point.score),shadowHadProbabilities:(report.shadowHadProbabilities||[]).map(point=>({score:String(point.score||""),probability:validProbability(point.probability)})).filter(point=>point.score),inputHash:String(report.inputHash||report.inputSnapshotId||""),parameters:report.parameters,
   hadProbabilities:[{score:"胜",probability:validProbability(report.layers?.fusionOutput?.probabilities?.home??report.probabilities?.home)},{score:"平",probability:validProbability(report.layers?.fusionOutput?.probabilities?.draw??report.probabilities?.draw)},{score:"负",probability:validProbability(report.layers?.fusionOutput?.probabilities?.away??report.probabilities?.away)}],
   hhadProbabilities:Array.isArray(report.marketSignal?.modeledHhad)&&report.marketSignal.modeledHhad.length===3?["让胜","让平","让负"].map((score,index)=>({score,probability:validProbability(report.marketSignal?.modeledHhad?.[index])})):undefined,
   totalGoalProbabilities:Array.isArray(report.marketSignal?.modeledTotalGoals)?["0球","1球","2球","3球","4球","5球","6球","7+球"].map((score,index)=>({score,probability:validProbability(report.marketSignal?.modeledTotalGoals?.[index])})):undefined,
   halfFullProbabilities:Array.isArray(report.marketSignal?.modeledHalfFull)?["胜胜","胜平","胜负","平胜","平平","平负","负胜","负平","负负"].map((score,index)=>({score,probability:validProbability(report.marketSignal?.modeledHalfFull?.[index])})):undefined,handicap:String(report.marketSignal?.officialHandicap||""),
   confidence:0,completeness:Math.max(1,10-(report.missingCompanies?.length||0)),singleModel:true,sourceFetchedAt:String(report.sourceFetchedAt||raw.sourceFetchedAt||raw.capturedAt||""),generatedAt:String(raw.capturedAt||"")
  }))
 };
}

export async function GET(request:Request){
 try{
  const view=new URL(request.url).searchParams.get("view");
  const bundledIndex=(Object.values(bundledIndexFiles)[0]||{}) as {snapshots?:Array<Record<string,unknown>>;resultCache?:Record<string,unknown>;purchasePlanSnapshots?:Array<Record<string,unknown>>;captureAttempts?:Array<any>};
  let cloud:{snapshots:Array<Record<string,unknown>>;purchases:Array<Record<string,unknown>>;probabilitySnapshots:Array<Record<string,unknown>>;auditPurchases:any[];attempts:any[]}={snapshots:[],purchases:[],probabilitySnapshots:[],auditPurchases:[],attempts:[]},cloudError:string|null=null;
  if(process.env.NODE_ENV==="production"){
   try{cloud=await cloudCaptureReadModel(getCloudResearchStore(),{
    projectRaw:(raw:any)=>toSnapshot(raw,`${raw.reports?.[0]?.salesDate}_${raw.scheduledTime}.raw.json`),
    projectPurchase:(raw:any)=>toPurchaseSnapshot(raw),
   });}catch(error){cloudError=error instanceof Error?error.message:"线上采集存储读取失败";}
  }
  const diskAttempts=await readCaptureAttempts().catch(()=>[]);
  const captureAttempts=[...new Map([...(bundledIndex.captureAttempts||[]),...diskAttempts,...cloud.attempts].map(r=>[`${r.salesDate}|${r.kind}|${r.slot}`,r])).values()];
  const bundledSnapshots=Array.isArray(bundledIndex.snapshots)?bundledIndex.snapshots.map(projectSnapshotOddsLayers):[];
  const bundledMigratedSnapshots=bundledSnapshots.filter(snapshot=>snapshot.storageOrigin==="migrated-browser");
  const bundledResultCache=bundledIndex.resultCache&&typeof bundledIndex.resultCache==="object"&&!Array.isArray(bundledIndex.resultCache)?bundledIndex.resultCache:{};
  const verifiedResultCache=Object.fromEntries(recoveredResults.results.map(result=>[`official|${result.matchId}`,withDerivedTotalGoals(result)]));
  const bundledPurchaseSnapshots=Array.isArray(bundledIndex.purchasePlanSnapshots)?bundledIndex.purchasePlanSnapshots:[];
  const diskPurchaseSnapshots=await readPurchaseSnapshotsFromDisk();
  const purchasePlanSnapshots=mergePurchaseHistorySnapshots([...bundledPurchaseSnapshots,...diskPurchaseSnapshots,...cloud.purchases]);
  const cloudAuditRecords=[...cloud.auditPurchases,...cloud.snapshots.filter(s=>s.includedInStrictEvaluation===false).map(s=>({snapshotId:s.snapshotId,scheduledAt:s.scheduledAt,capturedAt:s.inputCapturedAt,persistedAt:s.persistedAt,recovered:s.recovered,reason:s.executionReason||"完成凭证未满足严格时点要求",includedInStrictEvaluation:false}))];
  let disk:Array<ReturnType<typeof toSnapshot>>=[];
  try{
   const allNames=await readdir(directory),supplementNames=allNames.filter(name=>name.includes(".supplement."));
   const diskSupplements=(await Promise.all(supplementNames.map(async name=>{try{return JSON.parse(await readFile(join(directory,name),"utf8")) as Supplement}catch{return null}}))).filter(Boolean) as Supplement[];
   const names=allNames.filter(name=>/^\d{4}-\d{2}-\d{2}_(?:[01]\d|2[0-3])[0-5]\d(?:\.raw)?\.json$/.test(name));
   disk=await Promise.all(names.map(async name=>{
   try{return toSnapshot(JSON.parse(await readFile(join(directory,name),"utf8")) as RawSnapshot,name,diskSupplements);}catch{return null}
   }));
  }catch{/* Worker 运行时使用已打包快照；Node 运行时额外读取最新磁盘文件。 */}
  const diskSnapshots=Array.from(new Map(disk.filter(Boolean).map(snapshot=>[snapshot!.snapshotId,snapshot])).values()).sort((a,b)=>String(b!.capturedAt||b!.sourceFetchedAt).localeCompare(String(a!.capturedAt||a!.sourceFetchedAt)));
  const sourceSnapshots=[...(diskSnapshots.length?diskSnapshots:bundledSnapshots),...cloud.snapshots];
  const decisionRows=selectOfficialDecisionRows(sourceSnapshots.filter(snapshot=>snapshot.includedInStrictEvaluation!==false));
  const snapshots=Array.from(new Set(decisionRows.map(row=>row.salesDate))).map(date=>{
   const rows=decisionRows.filter(row=>row.salesDate===date).sort((a,b)=>String(a.match.id).localeCompare(String(b.match.id),"zh-CN",{numeric:true}));
   const completedAt=rows.map(row=>row.capturedAt).sort().at(-1)||"";
   return{snapshotId:`${date}-official-decision-v1`,immutable:true,schemaVersion:3,predictionId:`decision-${date}-v1`,date,scheduledAt:"",capturedAt:completedAt,sourceFetchedAt:completedAt,upstreamUpdatedAt:completedAt,decisionTiming:"pre_match",scheduleLabel:`每日正式复盘 · ${rows.length}场（按规定决策时点合并）`,storageOrigin:"server",matches:rows.map(row=>({...row.match,decisionTargetAt:row.targetAt,selectedSnapshotId:row.snapshot.snapshotId,selectedScheduledAt:row.scheduledAt,selectedCapturedAt:row.capturedAt,decisionPolicy:"actual_information_not_after_fixed_target_v2"}))};
  }).sort((a,b)=>b.date.localeCompare(a.date));
  const snapshotKey=(snapshot:Record<string,unknown>)=>`${snapshot.date}|${snapshot.sourceFetchedAt}|${snapshot.predictionId||"legacy"}`;
  const baseSnapshots=diskSnapshots.length||cloud.snapshots.length?Array.from(new Map([...(snapshots as unknown as Array<Record<string,unknown>>),...bundledSnapshots].map(snapshot=>[snapshotKey(snapshot),snapshot])).values()):bundledSnapshots;
  const recoverySnapshots=buildArchiveRecoverySnapshots(baseSnapshots,purchasePlanSnapshots);
  const responseSnapshots=[...recoverySnapshots,...baseSnapshots].sort((a,b)=>String(b.capturedAt||b.sourceFetchedAt).localeCompare(String(a.capturedAt||a.sourceFetchedAt)));
  const mergedEvaluationSnapshots=[...new Map([...((bundledIndex as any).evaluationSnapshots||bundledSnapshots),...((bundledIndex as any).probabilitySlotSnapshots||[]),...diskSnapshots,...purchasePlanSnapshots.map((s:any)=>s.evaluationSnapshot).filter(Boolean),...cloud.snapshots,...cloud.purchases.map((s:any)=>s.evaluationSnapshot).filter(Boolean),...cloud.probabilitySnapshots].map(projectSnapshotOddsLayers).map(s=>[s.snapshotId,s])).values()];
  const evaluationSnapshots=mergedEvaluationSnapshots.filter(s=>s.includedInStrictEvaluation!==false);const fixtureUniverse=[...captureAttempts.flatMap(r=>r.officialManifest||[]),...evaluationSnapshots.flatMap((snapshot:any)=>snapshot.fixtureUniverse?.length?snapshot.fixtureUniverse:snapshot.matches||[])].map((m:any)=>({officialMatchId:m.officialMatchId,salesDate:m.salesDate,kickoffAt:m.kickoffAt,home:m.home,away:m.away,league:m.league}));
  if(view==="recommendations")return NextResponse.json({cloudCaptureStatus:cloudError?"unavailable":"available",cloudError,cloudAuditRecords,captureAttempts,snapshots:[],probabilitySlotSnapshots:mergedEvaluationSnapshots.filter(isProbabilitySlotSnapshot),purchasePlanSnapshots,resultCache:{...bundledResultCache,...verifiedResultCache},storage:cloud.purchases.length?"cloud+bundle-index":diskPurchaseSnapshots.length?"disk+bundle-index":"bundle-index"},{headers:{"Cache-Control":"no-store, max-age=0"}});
  return NextResponse.json({cloudCaptureStatus:cloudError?"unavailable":"available",cloudError,cloudAuditRecords,captureAttempts,evaluationSnapshots,probabilitySlotSnapshots:mergedEvaluationSnapshots.filter(isProbabilitySlotSnapshot),fixtureUniverse,snapshots:responseSnapshots,resultCache:{...bundledResultCache,...verifiedResultCache},resultCorrections:verifiedResultCache,purchasePlanSnapshots,storage:cloud.snapshots.length||cloud.purchases.length?"cloud+bundle-index":diskSnapshots.length||diskPurchaseSnapshots.length?"disk+bundle-migration":"bundle-index"},{headers:{"Cache-Control":"no-store, max-age=0"}});
 }catch(error){
  return NextResponse.json({snapshots:[],error:error instanceof Error?error.message:"快照读取失败"},{status:500,headers:{"Cache-Control":"no-store, max-age=0"}});
 }
}
