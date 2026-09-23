import {readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";

const [inputPath,resultCachePath,outputPath="data/migrated-browser-prediction-snapshots.json"] = process.argv.slice(2);
if(!inputPath||!resultCachePath)throw new Error("用法：node scripts/import-browser-prediction-history.mjs <浏览器快照JSON> <浏览器赛果缓存JSON> [输出文件]");

const source=JSON.parse(await readFile(resolve(inputPath),"utf8"));
const resultCache=JSON.parse(await readFile(resolve(resultCachePath),"utf8"));
if(!Array.isArray(source))throw new Error("浏览器快照必须是数组");
if(!resultCache||typeof resultCache!=="object"||Array.isArray(resultCache))throw new Error("浏览器赛果缓存必须是对象");

const seen=new Set();
const snapshots=source.map((snapshot,index)=>{
 if(!snapshot||typeof snapshot!=="object"||!snapshot.date||!snapshot.sourceFetchedAt||!Array.isArray(snapshot.matches))throw new Error(`第 ${index+1} 个快照格式无效`);
 if(snapshot.matches.some(match=>match?.isMock===true))throw new Error(`第 ${index+1} 个快照包含演示比赛，拒绝导入`);
 const key=`${snapshot.date}|${snapshot.sourceFetchedAt}|${snapshot.predictionId||"legacy"}`;
 if(seen.has(key))throw new Error(`浏览器快照键重复：${key}`);
 seen.add(key);
 return {...snapshot,storageOrigin:"migrated-browser",scheduleLabel:snapshot.scheduleLabel||"本地浏览器历史迁移（非定时快照）",migrationSource:"localhost IndexedDB / ff-prediction-snapshots-v1"};
});

const normalizeName=value=>String(value||"").replace(/[\s·.·（）()]/g,"");
const parseDate=(value,fallback)=>{
 const sourceValue=String(value||""),full=sourceValue.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
 if(full)return `${full[1]}-${full[2].padStart(2,"0")}-${full[3].padStart(2,"0")}`;
 const short=sourceValue.match(/(?:^|\D)(\d{1,2})[-/](\d{1,2})(?:\D|$)/);
 return short&&/^\d{4}-\d{2}-\d{2}$/.test(fallback)?`${fallback.slice(0,4)}-${short[1].padStart(2,"0")}-${short[2].padStart(2,"0")}`:fallback;
};
const results=Object.values(resultCache),byOfficialId=new Map(),byDateAndId=new Map();
results.forEach(result=>{
 if(result?.matchId)byOfficialId.set(String(result.matchId),result);
 if(result?.date&&result?.id)byDateAndId.set(`${result.date}|${result.id}`,result);
});
results.forEach(result=>{if(result?.matchId)resultCache[`official|${result.matchId}`]=result;});
snapshots.forEach(snapshot=>snapshot.matches.forEach(match=>{
 const date=parseDate(match.matchDate||match.time||"",snapshot.date);
 const result=match.officialMatchId?byOfficialId.get(String(match.officialMatchId)):byDateAndId.get(`${date}|${match.id}`)||byDateAndId.get(`${snapshot.date}|${match.id}`);
 if(!result)return;
 const key=match.officialMatchId?`official|${match.officialMatchId}`:`${date}|${match.id}|${normalizeName(match.home)}|${normalizeName(match.away)}`;
 resultCache[key]=result;
}));

const payload={
 schemaVersion:1,
 migrationId:"localhost-browser-history-2026-09-23",
 importedAt:new Date().toISOString(),
 sourceOrigin:"http://localhost:3000",
 storageKey:"ff-prediction-snapshots-v1",
 snapshotCount:snapshots.length,
 matchCount:snapshots.reduce((sum,snapshot)=>sum+snapshot.matches.length,0),
 resultCount:Object.keys(resultCache).length,
 resultCache,
 snapshots
};
await writeFile(resolve(outputPath),`${JSON.stringify(payload)}\n`,"utf8");
console.log(JSON.stringify({status:"saved",outputPath,snapshotCount:payload.snapshotCount,matchCount:payload.matchCount}));
