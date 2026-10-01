import {createHash} from "node:crypto";
import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {generatePurchasePlans,deduplicatePurchasePlans,verifyPurchasePlanCompletion} from "../app/purchase-plan-engine.js";
import {collectEarlierPurchasePlans} from "../app/purchase-batch-policy.js";
import {runCapture} from "./capture-attempts.mjs";
import {purchaseCaptureWindow} from "../app/capture-window.js";
import {captureForwardCandidates} from "./capture-forward-candidates.mjs";
import {resolveServerOfficialMatches,assertCompletePurchaseEvaluation} from "../app/server-official-evidence.js";

const baseUrl=process.env.FOOTBALL_FOCUS_URL||"http://localhost:3000";
const directory=join(process.cwd(),"data","purchase-plan-snapshots");
const slot=process.argv.includes("--slot=2100")?"2100":"1700";
const slotTime=slot==="2100"?"21:00":"17:00";
const shanghaiParts=()=>Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(new Date()).map(part=>[part.type,part.value]));
const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cleanNumber=value=>Number.isFinite(Number(value))?Number(Number(value).toFixed(8)):0;
const materialPlans=plans=>plans.map(plan=>({id:plan.id,status:plan.status,reason:plan.reason||"",passName:plan.passName||"",estimatedProbability:cleanNumber(plan.estimatedProbability),betCount:cleanNumber(plan.betCount),stake:cleanNumber(plan.stake),minWinningReturn:cleanNumber(plan.minWinningReturn),maxWinningReturn:cleanNumber(plan.maxWinningReturn),minWinningProfit:cleanNumber(plan.minWinningProfit),maxWinningProfit:cleanNumber(plan.maxWinningProfit),items:(plan.items||[]).map(item=>({officialMatchId:item.officialMatchId||"",salesDate:item.salesDate||"",matchDate:item.matchDate||"",kickoffAt:item.kickoffAt||"",market:item.market,picks:(item.picks||[]).map(selection=>({pick:selection.pick,probability:cleanNumber(selection.probability),odd:cleanNumber(selection.odd)})),handicap:item.handicap||""}))}));
const requestJson=async(url,options)=>{const response=await fetch(url,{...options,signal:AbortSignal.timeout(120000)}),payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.error||`${url} 请求失败（${response.status}）`);return payload};

const result=await runCapture({kind:"purchase",slot},async audit=>{
await mkdir(directory,{recursive:true});
const parts=shanghaiParts(),date=`${parts.year}-${parts.month}-${parts.day}`;
const checkedAt=new Date().toISOString();
const window=purchaseCaptureWindow(date,slot,Date.now(),process.argv.includes("--pre-window"));
const latestAllowed=window.end;
audit.scheduledAt=`${date}T${slotTime}:00+08:00`;
if(!window.allowed)return {status:"skipped",reason:window.reason,slot,capturedAt:checkedAt};
const existingNames=(await readdir(directory)).filter(name=>name.startsWith(`${date}_`)&&name.endsWith(".json"));
for(const name of existingNames){try{const record=JSON.parse(await readFile(join(directory,name),"utf8"));if(record?.recordType==="purchase-plan-snapshot"&&record.immutable===true&&record.scheduledAt===`${date}T${slotTime}:00+08:00`&&Array.isArray(record?.planSet?.plans)&&record.planSet.plans.length){return {status:"skipped",reason:"daily-snapshot-exists",slot,snapshotId:record.snapshotId,capturedAt:checkedAt,version:record.planSet.version};}}catch{/* 损坏文件不阻断新快照。 */}}
audit.stage="official-source";
const matchesData=await requestJson(`${baseUrl}/api/sporttery`,{cache:"no-store"});
// 固定组合票严格按竞彩销售日生成；提前开售的次日场次不能混入当天方案。
const matches=(Array.isArray(matchesData.matches)?matchesData.matches:[]).filter(match=>String(match.salesDate||match.matchDate||"").slice(0,10)===date);
if(!matches.length)throw new Error("当前没有可生成方案的官方比赛数据");
if(matches.some(match=>!match.matchId||match.isMock))throw new Error("官方比赛中存在无 matchId 或 mock 数据，拒绝生成方案快照");

audit.officialManifest=matches.map(match=>({officialMatchId:String(match.officialMatchId||match.matchId),salesDate:match.salesDate,kickoffAt:match.kickoffAt,home:match.home,away:match.away,league:match.league}));
audit.sourceFetchedAt=matchesData.fetchedAt||null;
audit.stage="prediction-validation";
const predictionData=await requestJson(`${baseUrl}/api/predictions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({fixtureIds:matches.map(match=>String(match.officialMatchId||match.matchId||""))})});
const verifiedOfficialMatches=resolveServerOfficialMatches(predictionData,matches,date);
audit.officialManifest=verifiedOfficialMatches.map(match=>({officialMatchId:String(match.officialMatchId||match.matchId),salesDate:match.salesDate,kickoffAt:match.kickoffAt,home:match.home,away:match.away,league:match.league}));
audit.sourceFetchedAt=predictionData.officialSource.fetchedAt;
const realMatchIds=new Set(matches.map(match=>String(match.officialMatchId||match.matchId)));
const fetchedAt=predictionData.fetchedAt||matchesData.fetchedAt||new Date().toISOString();
const reports=(Array.isArray(predictionData.reports)?predictionData.reports:[]).filter(report=>report.id&&report.home&&report.away&&!report.isMock&&report.officialMappingStatus==="verified"&&realMatchIds.has(String(report.officialMatchId))).map(report=>({...report,sourceFetchedAt:report.sourceFetchedAt||fetchedAt}));
if(!reports.length)throw new Error("没有通过官方赛事映射校验的预测，未生成方案快照");

const inputDecisionAt=new Date().toISOString();
const scheduledAt=`${date}T${slotTime}:00+08:00`;
const earlierSets=[];
for(const name of existingNames){const record=JSON.parse(await readFile(join(directory,name),"utf8"));if(record.recordType==="purchase-plan-snapshot"&&record.immutable===true)earlierSets.push({...record.planSet,snapshotId:record.snapshotId,plans:deduplicatePurchasePlans(record.planSet?.plans)});}
const earlier=collectEarlierPurchasePlans(earlierSets,date);
if(slot==="2100"&&earlier.status!=="verified")throw new Error("17:00正式批次或不投注执行记录缺失/冲突，无法核验全天限额");
audit.stage="recommendation-screening";
const planSet=generatePurchasePlans({date,reports,officialMatches:verifiedOfficialMatches,generatedAt:inputDecisionAt,priorPlans:slot==="2100"?earlier.plans:[]});
assertCompletePurchaseEvaluation(planSet);
const capturedAt=new Date().toISOString(),captureParts=shanghaiParts();
verifyPurchasePlanCompletion(planSet,verifiedOfficialMatches,capturedAt);
planSet.inputDecisionAt=inputDecisionAt;planSet.generatedAt=capturedAt;planSet.completedAt=capturedAt;
audit.coverage=planSet.decisionSummary.coverage;
planSet.scheduledTime=slotTime;
if(!planSet.plans.some(plan=>plan.status!=="unavailable"&&plan.items?.length)&&!planSet.decisionSummary.noBet){
 return {status:"skipped",reason:"no-eligible-plans",capturedAt};

}
planSet.source=`${slotTime}计划批次，${captureParts.hour}:${captureParts.minute}实际生成 + 中国体育彩票生成时固定奖金`;
const contentHash=digest(materialPlans(planSet.plans));
const priorRecords=[];
for(const name of (await readdir(directory)).filter(name=>name.endsWith(".json"))){try{priorRecords.push(JSON.parse(await readFile(join(directory,name),"utf8")))}catch{/* 损坏文件不参与去重。 */}}
priorRecords.sort((a,b)=>String(b.capturedAt||"").localeCompare(String(a.capturedAt||"")));
const previous=priorRecords[0];
// Different decision times remain separate evidence even when selections match.

const clock=`${captureParts.hour}${captureParts.minute}${captureParts.second}`,snapshotId=`purchase-${date}-${clock}-${contentHash.slice(0,12)}`;
if(Date.now()>=latestAllowed){const error=new Error("实际采集完成已超过本批次重试截止时间");error.code="CAPTURE_LATE";throw error;}
audit.stage="immutable-write";
const record={decisionKind:planSet.decisionSummary.noBet?"no-bet-decision":"selected-tickets",schemaVersion:1,recordType:"purchase-plan-snapshot",snapshotId,immutable:true,scheduledAt,capturedAt,inputDecisionAt,completedAt:capturedAt,decisionTiming:Date.parse(capturedAt)>Date.parse(scheduledAt)?"delayed-batch":"on-time",sourceFetchedAt:fetchedAt,officialSource:predictionData.officialSource,officialMatches:verifiedOfficialMatches,upstreamUpdatedAt:predictionData.officialSource.upstreamUpdatedAt||null,predictionId:predictionData.predictionId||predictionData.version?.predictionId||"",predictionVersion:predictionData.version||null,inputHash:predictionData.version?.inputSnapshotId||"",contentHash,previousSnapshotId:previous?.snapshotId||null,reviewAfter:`${date}T23:59:59+08:00`,forecasts:reports,predictionInputs:reports.map(report=>({officialMatchId:report.officialMatchId,modelInput:report.modelInput,modelParameters:report.modelParameters,predictionId:report.predictionId})),planSet};
const output=join(directory,`${date}_${clock}_${contentHash.slice(0,12)}.json`);
await writeFile(output,`${JSON.stringify(record,null,2)}\n`,{encoding:"utf8",flag:"wx"});
audit.forwardResearch=await captureForwardCandidates({...record,reports:record.forecasts}).catch(error=>({status:"failed",reason:error.message}));
return {status:"saved",outcome:planSet.decisionSummary.noBet?"no_ticket":"saved",sourceMatchCount:matches.length,evaluatedFixtureCount:reports.length,slot,output,snapshotId,contentHash,capturedAt,plans:planSet.plans.filter(plan=>plan.status!=="unavailable").length};
});
console.log(JSON.stringify(result));
