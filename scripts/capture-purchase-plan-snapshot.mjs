import {createHash} from "node:crypto";
import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {generatePurchasePlans} from "../app/purchase-plan-engine.js";

const baseUrl=process.env.FOOTBALL_FOCUS_URL||"http://localhost:3000";
const directory=join(process.cwd(),"data","purchase-plan-snapshots");
const shanghaiParts=()=>Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).formatToParts(new Date()).map(part=>[part.type,part.value]));
const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cleanNumber=value=>Number.isFinite(Number(value))?Number(Number(value).toFixed(8)):0;
const materialPlans=plans=>plans.map(plan=>({id:plan.id,status:plan.status,reason:plan.reason||"",passName:plan.passName||"",estimatedProbability:cleanNumber(plan.estimatedProbability),betCount:cleanNumber(plan.betCount),stake:cleanNumber(plan.stake),minWinningReturn:cleanNumber(plan.minWinningReturn),maxWinningReturn:cleanNumber(plan.maxWinningReturn),minWinningProfit:cleanNumber(plan.minWinningProfit),maxWinningProfit:cleanNumber(plan.maxWinningProfit),items:(plan.items||[]).map(item=>({officialMatchId:item.officialMatchId||"",salesDate:item.salesDate||"",matchDate:item.matchDate||"",kickoffAt:item.kickoffAt||"",market:item.market,picks:(item.picks||[]).map(selection=>({pick:selection.pick,probability:cleanNumber(selection.probability),odd:cleanNumber(selection.odd)})),handicap:item.handicap||""}))}));
const requestJson=async(url,options)=>{const response=await fetch(url,options),payload=await response.json().catch(()=>({}));if(!response.ok)throw new Error(payload.error||`${url} 请求失败（${response.status}）`);return payload};

await mkdir(directory,{recursive:true});
const parts=shanghaiParts(),date=`${parts.year}-${parts.month}-${parts.day}`;
const checkedAt=new Date().toISOString();
if(process.env.FORCE_PURCHASE_SNAPSHOT!=="1"&&Number(parts.hour)<17){
 console.log(JSON.stringify({status:"skipped",reason:"before-daily-1700",capturedAt:checkedAt}));
 process.exit(0);
}
const existingNames=(await readdir(directory)).filter(name=>name.startsWith(`${date}_`)&&name.endsWith(".json"));
for(const name of existingNames){try{const record=JSON.parse(await readFile(join(directory,name),"utf8"));if(record?.recordType==="purchase-plan-snapshot"&&record.immutable===true&&Array.isArray(record?.planSet?.plans)&&record.planSet.plans.length){console.log(JSON.stringify({status:"skipped",reason:"daily-snapshot-exists",snapshotId:record.snapshotId,capturedAt:checkedAt,version:record.planSet.version}));process.exit(0)}}catch{/* 损坏文件不阻断新快照。 */}}
const matchesData=await requestJson(`${baseUrl}/api/sporttery`,{cache:"no-store"});
// 固定组合票严格按竞彩销售日生成；提前开售的次日场次不能混入当天方案。
const matches=(Array.isArray(matchesData.matches)?matchesData.matches:[]).filter(match=>String(match.salesDate||match.matchDate||"").slice(0,10)===date);
if(!matches.length)throw new Error("当前没有可生成方案的官方比赛数据");
if(matches.some(match=>!match.matchId||match.isMock))throw new Error("官方比赛中存在无 matchId 或 mock 数据，拒绝生成方案快照");

const predictionData=await requestJson(`${baseUrl}/api/predictions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({matches:matches.map(match=>({id:match.id,matchId:match.matchId,officialMatchId:match.officialMatchId||match.matchId,salesDate:match.salesDate,kickoffAt:match.kickoffAt,homeTeamId:match.homeTeamId,awayTeamId:match.awayTeamId,homeTeamCode:match.homeTeamCode,awayTeamCode:match.awayTeamCode,league:match.league,time:match.time,matchDate:match.matchDate,home:match.home,away:match.away,odds:match.odds,marketOdds:match.marketOdds,handicap:match.handicap,hhadOdds:match.marketOdds?.["让球胜平负"],matchStatus:match.matchStatus,marketEligibility:match.marketEligibility,updatedAt:match.updatedAt,isMock:false}))})});
const realMatchIds=new Set(matches.map(match=>String(match.officialMatchId||match.matchId)));
const fetchedAt=predictionData.fetchedAt||matchesData.fetchedAt||new Date().toISOString();
const reports=(Array.isArray(predictionData.reports)?predictionData.reports:[]).filter(report=>report.id&&report.home&&report.away&&!report.isMock&&report.officialMappingStatus==="verified"&&realMatchIds.has(String(report.officialMatchId))).map(report=>({...report,sourceFetchedAt:fetchedAt}));
if(!reports.length)throw new Error("没有通过官方赛事映射校验的预测，未生成方案快照");

const capturedAt=new Date().toISOString();
const planSet=generatePurchasePlans({date,reports,officialMatches:matches,generatedAt:capturedAt});
if(!planSet.plans.some(plan=>plan.status!=="unavailable"&&plan.items?.length)){
 console.log(JSON.stringify({status:"skipped",reason:"no-eligible-plans",capturedAt}));
 process.exit(0);
}
planSet.source="每日17:00预测快照 + 中国体育彩票生成时固定奖金";
const contentHash=digest(materialPlans(planSet.plans));
const priorRecords=[];
for(const name of (await readdir(directory)).filter(name=>name.endsWith(".json"))){try{priorRecords.push(JSON.parse(await readFile(join(directory,name),"utf8")))}catch{/* 损坏文件不参与去重。 */}}
priorRecords.sort((a,b)=>String(b.capturedAt||"").localeCompare(String(a.capturedAt||"")));
const previous=priorRecords[0];
if(previous?.contentHash===contentHash){
 console.log(JSON.stringify({status:"skipped",reason:"unchanged",comparedWith:previous.snapshotId,contentHash,capturedAt}));
 process.exit(0);
}

const clock=`${parts.hour}${parts.minute}${parts.second}`,snapshotId=`purchase-${date}-${clock}-${contentHash.slice(0,12)}`;
const record={schemaVersion:1,recordType:"purchase-plan-snapshot",snapshotId,immutable:true,capturedAt,sourceFetchedAt:fetchedAt,upstreamUpdatedAt:predictionData.fetchedAt||matchesData.fetchedAt||fetchedAt,predictionId:predictionData.predictionId||predictionData.version?.predictionId||"",predictionVersion:predictionData.version||null,inputHash:predictionData.version?.inputSnapshotId||"",contentHash,previousSnapshotId:previous?.snapshotId||null,reviewAfter:`${date}T23:59:59+08:00`,planSet};
const output=join(directory,`${date}_${clock}_${contentHash.slice(0,12)}.json`);
await writeFile(output,`${JSON.stringify(record,null,2)}\n`,{encoding:"utf8",flag:"wx"});
console.log(JSON.stringify({status:"saved",output,snapshotId,contentHash,capturedAt,plans:planSet.plans.filter(plan=>plan.status!=="unavailable").length}));
