import {readdir,readFile} from "node:fs/promises";
import {join} from "node:path";
import {NextResponse} from "next/server";
import {selectOfficialDecisionRows} from "../../snapshot-decision-policy.js";

export const dynamic="force-dynamic";

type RawReport={
 id?:string;officialMatchId?:string;salesDate?:string;kickoffAt?:string;homeTeamId?:string;awayTeamId?:string;homeTeamCode?:string;awayTeamCode?:string;officialMappingStatus?:string;marketEligibility?:Record<string,unknown>;league?:string;time?:string;matchDate?:string;home?:string;away?:string;matchStatus?:string;isMock?:boolean;sourceUpdatedAt?:string;
 predictionId?:string;inputSnapshotId?:string;baseModelVersion?:string;calibrationVersion?:string;predictionGeneratedAt?:string;fullScoreDistribution?:Array<{score?:string;probability?:number}>;shadowFullScoreDistribution?:Array<{score?:string;probability?:number}>;shadowHadProbabilities?:Array<{score?:string;probability?:number}>;scores?:Array<{score?:string;probability?:number}>;oddsScores?:Array<{score?:string;probability?:number}>;marketProbabilities?:number[];intelligenceScores?:Array<{score?:string;probability?:number}>;intelligenceCoverage?:number;appliedIntelligenceWeight?:number;aiSummary?:string;aiRisk?:string;probabilities?:{home?:number;draw?:number;away?:number};expectedGoals?:{home?:number;away?:number};
 layers?:{oddsBaseline?:{fullScoreDistribution?:Array<{score?:string;probability?:number}>;probabilities?:{home?:number;draw?:number;away?:number}};intelligenceOutput?:{scores?:Array<{score?:string;probability?:number}>;coverage?:number;summary?:string;risk?:string;evidence?:unknown[]};fusionOutput?:{fullScoreDistribution?:Array<{score?:string;probability?:number}>;probabilities?:{home?:number;draw?:number;away?:number};hhad?:number[];totalGoals?:number[];halfFull?:number[]}};inputHash?:string;parameters?:unknown;
 marketSignal?:{modeledHhad?:number[];modeledTotalGoals?:number[];modeledHalfFull?:number[];officialHandicap?:string;rawProbabilities?:number[]};consensus?:{agreement?:string};missingCompanies?:unknown[];companies?:unknown[];
};
type RawSnapshot={schemaVersion?:number;recordType?:string;snapshotId?:string;immutable?:boolean;predictionId?:string;version?:unknown;scheduledAt?:string;capturedAt?:string;upstreamUpdatedAt?:string;scheduledTime?:string;sourceFetchedAt?:string;decisionTiming?:string;reports?:RawReport[];aiProvider?:string;purchasePlans?:unknown;inputHash?:string;officialMatches?:unknown[]};
type Supplement={recordId?:string;kind?:"ai-review"|"purchase-plans"|"result-correction";baseSnapshotId?:string;inputPredictionId?:string;outputPredictionId?:string;createdAt?:string;aiCompletedAt?:string;decisionTiming?:string;includedInPreMatchEvaluation?:boolean;provider?:string;version?:unknown;reports?:RawReport[];plans?:unknown};
type RawPurchaseSnapshot={recordType?:string;immutable?:boolean;snapshotId?:string;capturedAt?:string;sourceFetchedAt?:string;predictionId?:string;contentHash?:string;previousSnapshotId?:string;planSet?:{plans?:unknown[];[key:string]:unknown}};

const directory=join(process.cwd(),"data","prediction-snapshots");
const purchaseDirectory=join(process.cwd(),"data","purchase-plan-snapshots");
// 线上 Worker 只加载预先生成的紧凑索引。原始快照和 AI 补充文件仍完整保留在
// data/prediction-snapshots 供本地审计，但不得逐个 eager import 到 128MB Worker。
const bundledIndexFiles=import.meta.glob<{snapshots?:unknown[];purchasePlanSnapshots?:unknown[]}>("../../../data/generated-prediction-snapshot-index.json",{eager:true,import:"default"});
const toPurchaseSnapshot=(record:RawPurchaseSnapshot)=>record.recordType==="purchase-plan-snapshot"&&record.immutable===true&&record.snapshotId&&record.planSet?.plans?.length?{snapshotId:record.snapshotId,capturedAt:record.capturedAt,sourceFetchedAt:record.sourceFetchedAt,predictionId:record.predictionId,contentHash:record.contentHash,previousSnapshotId:record.previousSnapshotId,planSet:{...record.planSet,snapshotId:record.snapshotId,contentHash:record.contentHash}}:null;
const labelFor=(slot:string)=>`${slot.slice(0,2)}:${slot.slice(2)}批次`;
const number=(value:unknown)=>Number.isFinite(Number(value))?Number(value):0;

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
  matches:reports.filter(report=>report.id&&report.home&&report.away).map(report=>({
   predictionId:String(report.predictionId||raw.predictionId||""),inputSnapshotId:String(report.inputSnapshotId||""),baseModelVersion:String(report.baseModelVersion||""),calibrationVersion:String(report.calibrationVersion||""),predictionGeneratedAt:String(report.predictionGeneratedAt||raw.capturedAt||""),fullScoreDistribution:(report.layers?.fusionOutput?.fullScoreDistribution||report.fullScoreDistribution||report.scores||[]).map(point=>({score:String(point.score||""),probability:number(point.probability)})).filter(point=>point.score),expectedGoals:{home:number(report.expectedGoals?.home),away:number(report.expectedGoals?.away)},appliedIntelligenceWeight:number(report.appliedIntelligenceWeight),id:String(report.id),officialMatchId:String(report.officialMatchId||""),salesDate:String(report.salesDate||""),kickoffAt:String(report.kickoffAt||""),homeTeamId:String(report.homeTeamId||""),awayTeamId:String(report.awayTeamId||""),homeTeamCode:String(report.homeTeamCode||""),awayTeamCode:String(report.awayTeamCode||""),officialMappingStatus:String(report.officialMappingStatus||""),marketEligibility:report.marketEligibility,league:String(report.league||""),time:String(report.time||""),matchDate:String(report.matchDate||report.time||""),home:String(report.home),away:String(report.away),matchStatus:String(report.matchStatus||""),isMock:Boolean(report.isMock),
   oddsScores:(report.layers?.oddsBaseline?.fullScoreDistribution||report.oddsScores||[]).map(point=>({score:String(point.score||""),probability:number(point.probability)})).filter(point=>point.score),marketHadProbabilities:(()=>{const values=report.layers?.oddsBaseline?.probabilities;return values?[{score:"胜",probability:number(values.home)},{score:"平",probability:number(values.draw)},{score:"负",probability:number(values.away)}]:Array.isArray(report.marketProbabilities)&&report.marketProbabilities.length===3?["胜","平","负"].map((score,index)=>({score,probability:number(report.marketProbabilities?.[index])})):Array.isArray(report.marketSignal?.rawProbabilities)&&report.marketSignal.rawProbabilities.length===3?["胜","平","负"].map((score,index)=>({score,probability:number(report.marketSignal?.rawProbabilities?.[index])})):[]})(),
   intelligenceScores:(report.layers?.intelligenceOutput?.scores||report.intelligenceScores||[]).map(point=>({score:String(point.score||""),probability:number(point.probability)})).filter(point=>point.score),intelligenceCoverage:number(report.layers?.intelligenceOutput?.coverage??report.intelligenceCoverage),aiSummary:String(report.layers?.intelligenceOutput?.summary||report.aiSummary||""),aiRisk:String(report.layers?.intelligenceOutput?.risk||report.aiRisk||""),
   combinedScores:(report.layers?.fusionOutput?.fullScoreDistribution||report.fullScoreDistribution||report.scores||[]).map(point=>({score:String(point.score||""),probability:number(point.probability)})).filter(point=>point.score),shadowFullScoreDistribution:(report.shadowFullScoreDistribution||[]).map(point=>({score:String(point.score||""),probability:number(point.probability)})).filter(point=>point.score),shadowHadProbabilities:(report.shadowHadProbabilities||[]).map(point=>({score:String(point.score||""),probability:number(point.probability)})).filter(point=>point.score),inputHash:String(report.inputHash||report.inputSnapshotId||""),parameters:report.parameters,
   hadProbabilities:[{score:"胜",probability:number(report.layers?.fusionOutput?.probabilities?.home??report.probabilities?.home)},{score:"平",probability:number(report.layers?.fusionOutput?.probabilities?.draw??report.probabilities?.draw)},{score:"负",probability:number(report.layers?.fusionOutput?.probabilities?.away??report.probabilities?.away)}],
   hhadProbabilities:Array.isArray(report.marketSignal?.modeledHhad)&&report.marketSignal.modeledHhad.length===3?["让胜","让平","让负"].map((score,index)=>({score,probability:number(report.marketSignal?.modeledHhad?.[index])})):undefined,
   totalGoalProbabilities:Array.isArray(report.marketSignal?.modeledTotalGoals)?["0球","1球","2球","3球","4球","5球","6球","7+球"].map((score,index)=>({score,probability:number(report.marketSignal?.modeledTotalGoals?.[index])})):undefined,
   halfFullProbabilities:Array.isArray(report.marketSignal?.modeledHalfFull)?["胜胜","胜平","胜负","平胜","平平","平负","负胜","负平","负负"].map((score,index)=>({score,probability:number(report.marketSignal?.modeledHalfFull?.[index])})):undefined,handicap:String(report.marketSignal?.officialHandicap||""),
   confidence:report.consensus?.agreement==="较一致"?82:64,completeness:Math.max(1,10-(report.missingCompanies?.length||0)),singleModel:true,sourceFetchedAt:String(raw.sourceFetchedAt||raw.capturedAt||""),generatedAt:String(raw.capturedAt||"")
  }))
 };
}

export async function GET(request:Request){
 try{
  const view=new URL(request.url).searchParams.get("view");
  const bundledIndex=(Object.values(bundledIndexFiles)[0]||{}) as {snapshots?:Array<Record<string,unknown>>;purchasePlanSnapshots?:Array<Record<string,unknown>>};
  const bundledSnapshots=Array.isArray(bundledIndex.snapshots)?bundledIndex.snapshots:[];
  const bundledPurchaseSnapshots=Array.isArray(bundledIndex.purchasePlanSnapshots)?bundledIndex.purchasePlanSnapshots:[];
  if(view==="recommendations")return NextResponse.json({snapshots:[],purchasePlanSnapshots:bundledPurchaseSnapshots,storage:"bundle-index"},{headers:{"Cache-Control":"no-store, max-age=0"}});
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
  const sourceSnapshots=diskSnapshots.length?diskSnapshots:bundledSnapshots;
  const decisionRows=selectOfficialDecisionRows(sourceSnapshots);
  const snapshots=Array.from(new Set(decisionRows.map(row=>row.salesDate))).map(date=>{
   const rows=decisionRows.filter(row=>row.salesDate===date).sort((a,b)=>String(a.match.id).localeCompare(String(b.match.id),"zh-CN",{numeric:true}));
   const completedAt=rows.map(row=>row.capturedAt).sort().at(-1)||"";
   return{snapshotId:`${date}-official-decision-v1`,immutable:true,schemaVersion:3,predictionId:`decision-${date}-v1`,date,scheduledAt:"",capturedAt:completedAt,sourceFetchedAt:completedAt,upstreamUpdatedAt:completedAt,decisionTiming:"pre_match",scheduleLabel:`每日正式复盘 · ${rows.length}场（按规定决策时点合并）`,storageOrigin:"server",matches:rows.map(row=>({...row.match,decisionTargetAt:row.targetAt,selectedSnapshotId:row.snapshot.snapshotId,selectedCapturedAt:row.capturedAt,decisionPolicy:"latest_not_after_official_target_v1"}))};
  }).sort((a,b)=>b.date.localeCompare(a.date));
  let diskPurchaseSnapshots:Array<ReturnType<typeof toPurchaseSnapshot>>=[];
  try{
   const names=(await readdir(purchaseDirectory)).filter(name=>name.endsWith(".json"));
   diskPurchaseSnapshots=await Promise.all(names.map(async name=>{try{return toPurchaseSnapshot(JSON.parse(await readFile(join(purchaseDirectory,name),"utf8")))}catch{return null}}));
  }catch{/* Worker 使用打包的独立方案快照，不能依赖本机磁盘。 */}
  const purchasePlanSnapshots=diskPurchaseSnapshots.some(Boolean)?Array.from(new Map(diskPurchaseSnapshots.filter(record=>record!==null).map(record=>[record!.snapshotId,record])).values()).sort((a,b)=>String(b!.capturedAt||"").localeCompare(String(a!.capturedAt||""))):bundledPurchaseSnapshots;
  return NextResponse.json({snapshots:diskSnapshots.length?snapshots:bundledSnapshots,purchasePlanSnapshots,storage:diskSnapshots.length||diskPurchaseSnapshots.some(Boolean)?"disk":"bundle-index"},{headers:{"Cache-Control":"no-store, max-age=0"}});
 }catch(error){
  return NextResponse.json({snapshots:[],error:error instanceof Error?error.message:"快照读取失败"},{status:500,headers:{"Cache-Control":"no-store, max-age=0"}});
 }
}
