import {createHash} from "node:crypto";
import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {generatePurchasePlans,MARKET_META} from "../app/purchase-plan-engine.js";
import {captureWindow,captureEvidence,assertOfficialInput,assertCoverage,requestJson,selectSellingInputs,changedOfficialOdds} from "./capture-contract.mjs";
import {writePurchaseAttempt} from "./purchase-capture-attempt.mjs";
import {recommendationComplete} from "../app/purchase-snapshot-status.js";

const baseUrl=process.env.FOOTBALL_FOCUS_URL||"http://localhost:3000";
const directory=join(process.cwd(),"data","purchase-plan-snapshots");
const current=process.argv.includes("--current");
const slot=current?"current":process.argv.includes("--slot=2100")?"2100":"1700";
const slotTime=current?new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Shanghai",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date()):slot==="2100"?"21:00":"17:00";
const shanghaiParts=()=>Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(new Date()).map(part=>[part.type,part.value]));
const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cleanNumber=value=>Number.isFinite(Number(value))?Number(Number(value).toFixed(8)):0;
const materialPlans=plans=>plans.map(plan=>({id:plan.id,status:plan.status,reason:plan.reason||"",passName:plan.passName||"",estimatedProbability:cleanNumber(plan.estimatedProbability),betCount:cleanNumber(plan.betCount),stake:cleanNumber(plan.stake),minWinningReturn:cleanNumber(plan.minWinningReturn),maxWinningReturn:cleanNumber(plan.maxWinningReturn),minWinningProfit:cleanNumber(plan.minWinningProfit),maxWinningProfit:cleanNumber(plan.maxWinningProfit),items:(plan.items||[]).map(item=>({officialMatchId:item.officialMatchId||"",salesDate:item.salesDate||"",matchDate:item.matchDate||"",kickoffAt:item.kickoffAt||"",market:item.market,picks:(item.picks||[]).map(selection=>({pick:selection.pick,probability:cleanNumber(selection.probability),odd:cleanNumber(selection.odd)})),handicap:item.handicap||""}))}));

await mkdir(directory,{recursive:true});
const parts=shanghaiParts(),date=`${parts.year}-${parts.month}-${parts.day}`;
const checkedAt=new Date().toISOString();
const scheduledAt=current?checkedAt:`${date}T${slotTime}:00+08:00`;
const attemptBase={date,slot,scheduledAt,startedAt:checkedAt};
process.once("uncaughtException",async error=>{
 try{
  const attempt=await writePurchaseAttempt({...attemptBase,status:"failed",code:error.code||"CAPTURE_FAILED",reason:error.message,officialMatchId:error.officialMatchId});
  console.error(JSON.stringify({status:"failed",slot,scheduledAt,startedAt:checkedAt,code:error.code||"CAPTURE_FAILED",reason:error.message,...attempt}));
 }catch(storageError){console.error(JSON.stringify({status:"failed",slot,reason:error.message,attemptWriteError:storageError.message}));}
 process.exit(1);
});
const windowState=captureWindow(Date.parse(checkedAt),scheduledAt,{purchase:true,preWindow:process.argv.includes("--pre-window")});
if(windowState!=="eligible"){
 console.log(JSON.stringify({status:"skipped",reason:windowState==="before-window"?`before-daily-${slot}`:"capture-window-closed",slot,checkedAt}));
 process.exit(0);
}
const existingNames=(await readdir(directory)).filter(name=>name.startsWith(`${date}_`)&&name.endsWith(".json"));
const batchRecords=[];
for(const name of existingNames){try{const record=JSON.parse(await readFile(join(directory,name),"utf8"));if(record?.recordType==="purchase-plan-snapshot"&&record.immutable===true&&record.scheduledAt===scheduledAt&&Array.isArray(record?.planSet?.plans)&&record.planSet.plans.length){batchRecords.push(record);if(recommendationComplete(record)){console.log(JSON.stringify({status:"skipped",reason:"daily-snapshot-exists",slot,snapshotId:record.snapshotId,checkedAt,version:record.planSet.version}));process.exit(0)}}}catch{/* 损坏文件不阻断新快照。 */}}
const matchesData=await requestJson(`${baseUrl}/api/sporttery`,{cache:"no-store"});
// 固定组合票严格按竞彩销售日生成；提前开售的次日场次不能混入当天方案。
if(!Array.isArray(matchesData.matches))throw new Error("官方清单未知，拒绝留档");
const {matches,excluded}=selectSellingInputs(matchesData,date,Date.now());
if(!matches.length){const error=new Error("当前没有合格且在售的官方比赛数据");error.code="NO_ELIGIBLE_OFFICIAL_MATCHES";throw error;}
if(matches.some(match=>!match.matchId||match.isMock))throw new Error("官方比赛中存在无 matchId 或 mock 数据，拒绝生成方案快照");
assertOfficialInput(matchesData,matches,Date.now(),{allowMissingCutoff:true});

const predictionData=await requestJson(`${baseUrl}/api/predictions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({matches:matches.map(match=>({id:match.id,matchId:match.matchId,officialMatchId:match.officialMatchId||match.matchId,salesDate:match.salesDate,kickoffAt:match.kickoffAt,homeTeamId:match.homeTeamId,awayTeamId:match.awayTeamId,homeTeamCode:match.homeTeamCode,awayTeamCode:match.awayTeamCode,league:match.league,time:match.time,matchDate:match.matchDate,home:match.home,away:match.away,sourceFetchedAt:matchesData.fetchedAt,odds:match.odds,marketOdds:match.marketOdds,handicap:match.handicap,hhadOdds:match.marketOdds?.["让球胜平负"],matchStatus:match.matchStatus,marketEligibility:match.marketEligibility,updatedAt:match.updatedAt,isMock:false}))})});
const realMatchIds=new Set(matches.map(match=>String(match.officialMatchId||match.matchId)));
const fetchedAt=predictionData.fetchedAt||matchesData.fetchedAt||new Date().toISOString();
const reports=(Array.isArray(predictionData.reports)?predictionData.reports:[]).filter(report=>report.id&&report.home&&report.away&&!report.isMock&&report.officialMappingStatus==="verified"&&realMatchIds.has(String(report.officialMatchId))).map(report=>({...report,sourceFetchedAt:report.sourceFetchedAt||fetchedAt}));
if(!reports.length)throw new Error("没有通过官方赛事映射校验的预测，未生成方案快照");
const predictedIds=new Set(reports.map(report=>String(report.officialMatchId)));
for(const match of matches.filter(match=>!predictedIds.has(String(match.officialMatchId||match.matchId))))excluded.push({id:match.id,officialMatchId:String(match.officialMatchId||match.matchId),code:"PREDICTION_UNAVAILABLE",reason:predictionData.unavailableOfficialMatches?.find(row=>row.officialMatchId===String(match.officialMatchId||match.matchId))?.reason||"预测未通过核验"});
const evaluatedMatches=matches.filter(match=>predictedIds.has(String(match.officialMatchId||match.matchId)));
assertCoverage(evaluatedMatches,reports);

const capturedAt=new Date().toISOString();
const captureParts=shanghaiParts();
const planSet=generatePurchasePlans({date,reports,officialMatches:matches,generatedAt:capturedAt});
planSet.scheduledTime=slotTime;
if(!planSet.plans.some(plan=>plan.status!=="unavailable"&&plan.items?.length)){
 await writePurchaseAttempt({...attemptBase,status:"no-eligible-plans",code:"NO_ELIGIBLE_PLANS",reason:"完整评估后无合格组合"});
 console.log(JSON.stringify({status:"skipped",reason:"no-eligible-plans",capturedAt}));
 process.exit(0);
}
planSet.source=`${slotTime}计划批次，${captureParts.hour}:${captureParts.minute}实际生成 + 中国体育彩票生成时固定奖金`;
const contentHash=digest(materialPlans(planSet.plans));
const priorRecords=[];
for(const name of (await readdir(directory)).filter(name=>name.endsWith(".json"))){try{priorRecords.push(JSON.parse(await readFile(join(directory,name),"utf8")))}catch{/* 损坏文件不参与去重。 */}}
priorRecords.sort((a,b)=>String(b.capturedAt||"").localeCompare(String(a.capturedAt||"")));
const previous=priorRecords[0];
// Different decision times remain separate evidence even when selections match.

const clock=`${captureParts.hour}${captureParts.minute}${captureParts.second}`,snapshotId=`purchase-${date}-${clock}-${contentHash.slice(0,12)}`;
const record={schemaVersion:1,recordType:"purchase-plan-snapshot",snapshotId,immutable:true,scheduledAt,capturedAt,sourceFetchedAt:fetchedAt,upstreamUpdatedAt:predictionData.fetchedAt||matchesData.fetchedAt||fetchedAt,predictionId:predictionData.predictionId||predictionData.version?.predictionId||"",predictionVersion:predictionData.version||null,inputHash:predictionData.version?.inputSnapshotId||"",contentHash,previousSnapshotId:previous?.snapshotId||null,reviewAfter:`${date}T23:59:59+08:00`,predictionInputs:reports.map(report=>({officialMatchId:report.officialMatchId,modelInput:report.modelInput,modelParameters:report.modelParameters,predictionId:report.predictionId})),planSet};
const refreshed=await requestJson(`${baseUrl}/api/sporttery`,{cache:"no-store"});
const freshById=new Map((refreshed.matches||[]).map(match=>[String(match.officialMatchId||match.matchId),match]));
for(const used of evaluatedMatches){
 const latest=freshById.get(String(used.officialMatchId||used.matchId));
 if(!latest)throw new Error(`${used.id}：写入前官方已停售或移出清单`);
 if(latest.salesDate!==used.salesDate||latest.kickoffAt!==used.kickoffAt||latest.home!==used.home||latest.away!==used.away)throw new Error(`${used.id}：写入前官方身份或开赛时间已变化`);
 assertOfficialInput(refreshed,[latest],Date.now(),{allowMissingCutoff:true});
 const changed=changedOfficialOdds(used.marketOdds,latest.marketOdds);
 if(changed.length)throw new Error(`${used.id}：写入前官方${changed.join("、")}赔率已变化，请重新计算`);
}
for(const plan of planSet.plans)for(const item of plan.items||[]){
 const latest=freshById.get(String(item.officialMatchId)),market=latest?.marketEligibility?.[MARKET_META[item.market]?.name];
 if(!market||market.qualification!=="qualified"||String(market.salesStatus).toLowerCase()!=="selling"||(market.cutoffAt&&!(Date.parse(market.cutoffAt)>Date.now())))throw new Error("写入前所选玩法已停售或资格失效");
}
const completedAt=new Date().toISOString();
record.inputHash||=digest(matches);
Object.assign(record,captureEvidence(scheduledAt,checkedAt,capturedAt,completedAt,reports),{modelVersion:predictionData.version?.modelVersion||reports[0]?.baseModelVersion||predictionData.methodology});
record.sourceCoverage={listed:matchesData.matches.filter(match=>match.salesDate===date).length,eligible:matches.length,predicted:reports.length,excluded};
record.cutoffStatus=evaluatedMatches.some(match=>Object.values(match.marketEligibility||{}).some(m=>m.qualification==="qualified"&&m.cutoffStatus==="unknown"))?"unknown":"provided";
record.qualityStatus=reports.length<matches.length?"partial":record.cutoffStatus==="unknown"?"cutoff-unknown":"complete";
if(current||record.qualityStatus!=="complete"){record.includedInStrictEvaluation=false;record.includedInPreMatchEvaluation=false;}
if(record.cutoffStatus==="unknown")planSet.source=`官方在售状态确认；停售时间未知（不进入严格验证） · ${planSet.source}`;
if(excluded.length)planSet.source=`已核验部分场次，排除${excluded.length}场 · ${planSet.source}`;
Object.assign(planSet,{captureTiming:record.captureTiming,includedInStrictEvaluation:record.includedInStrictEvaluation,qualityStatus:record.qualityStatus,cutoffStatus:record.cutoffStatus,sourceCoverage:record.sourceCoverage});
if(current)planSet.source=`当前实际采集（非17点/21点批次） · ${planSet.source}`;
else if(record.captureTiming==="delayed")planSet.source=`延迟批次（不进入严格前瞻验证） · ${planSet.source}`;
// Partial recovery appends a distinct immutable result; identical retries share a wx boundary.
const resultKey=value=>digest({contentHash:value.contentHash,coverage:value.sourceCoverage,cutoffStatus:value.cutoffStatus});
if(batchRecords.some(prior=>resultKey(prior)===resultKey(record))){
 await writePurchaseAttempt({...attemptBase,status:"unchanged",snapshotId:batchRecords[0].snapshotId,reason:"重新采集结果未变化，保留已有部分记录"});
 console.log(JSON.stringify({status:"skipped",reason:"unchanged-partial-snapshot",slot,checkedAt}));process.exit(0);
}
const output=join(directory,current?`${date}_current_${clock}.purchase.json`:batchRecords.length?`${date}_${slot}_retry_${resultKey(record).slice(0,16)}.purchase.json`:`${date}_${slot}.purchase.json`);
await writeFile(output,`${JSON.stringify(record,null,2)}\n`,{encoding:"utf8",flag:"wx"}).catch(error=>{
 if(error.code!=="EEXIST")throw error;
 console.log(JSON.stringify({status:"skipped",reason:"daily-snapshot-exists",slot,checkedAt}));
 process.exit(0);
});
if(JSON.parse(await readFile(output,"utf8")).contentHash!==contentHash)throw new Error("留档写入读回失败");
await writePurchaseAttempt({...attemptBase,status:"saved",snapshotId});
console.log(JSON.stringify({status:"saved",slot,output,snapshotId,contentHash,capturedAt,plans:planSet.plans.filter(plan=>plan.status!=="unavailable").length}));
