import {readdir,readFile} from "node:fs/promises";
import {join} from "node:path";
import {NextResponse} from "next/server";
import {projectRawPredictionSnapshot as toSnapshot,projectOfficialDecisionSnapshots} from "../../raw-snapshot-projection.js";
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
const withDerivedTotalGoals=<T extends {fullScore?:string;totalGoalsResult?:string}>(result:T)=>{
 if(result.totalGoalsResult)return result;
 const score=/^(\d{1,2}):(\d{1,2})$/.exec(String(result.fullScore||"").trim());
 if(!score)return result;
 const goals=Number(score[1])+Number(score[2]);
 return {...result,totalGoalsResult:goals>=7?"7+":String(goals),totalGoalsResultBasis:"derived_from_verified_full_score"};
};


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
  const snapshots=projectOfficialDecisionSnapshots(sourceSnapshots);
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
