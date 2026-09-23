import {spawnSync} from "node:child_process";
import {mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {snapshotIdFromFileName} from "../app/snapshot-file-policy.js";

const baseUrl=process.env.FOOTBALL_FOCUS_URL||"http://127.0.0.1:3000";
const response=await fetch(`${baseUrl}/api/prediction-snapshots`,{cache:"no-store"});
const data=await response.json().catch(()=>({}));
if(!response.ok)throw new Error(data.error||"盘后快照读取失败");
const formalSourceSnapshots=(data.snapshots||[]).filter(snapshot=>snapshot.storageOrigin!=="migrated-browser");
const days=formalSourceSnapshots.map(snapshot=>({date:snapshot.date,snapshotId:snapshot.snapshotId,matchCount:snapshot.matches?.length||0,matches:(snapshot.matches||[]).map(match=>({officialMatchId:match.officialMatchId,id:match.id,home:match.home,away:match.away,kickoffAt:match.kickoffAt,decisionTargetAt:match.decisionTargetAt,selectedSnapshotId:match.selectedSnapshotId,selectedScheduledAt:match.selectedScheduledAt,selectedCapturedAt:match.selectedCapturedAt,decisionPolicy:match.decisionPolicy}))}));
const output={schemaVersion:1,policy:"latest_not_after_official_target_v1",generatedAt:new Date().toISOString(),rules:{weekday:"22:00及以后统一21:30，否则开赛前30分钟",weekend:"23:00及以后统一22:30，否则开赛前30分钟"},days};
const directory=join(process.cwd(),"data","analysis");await mkdir(directory,{recursive:true});
const path=join(directory,"prediction-decision-index.json");await writeFile(path,`${JSON.stringify(output,null,2)}\n`,"utf8");
const bundlePath=join(process.cwd(),"data","generated-prediction-snapshot-index.json");
const migrationPath=join(process.cwd(),"data","migrated-browser-prediction-snapshots.json");
const migration=JSON.parse(await readFile(migrationPath,"utf8").catch(()=>"{\"snapshots\":[]}"));
const migratedSnapshots=Array.isArray(migration.snapshots)?migration.snapshots:[];
const resultCache=migration.resultCache&&typeof migration.resultCache==="object"&&!Array.isArray(migration.resultCache)?migration.resultCache:{};
if(migratedSnapshots.some(snapshot=>!Array.isArray(snapshot.matches)||snapshot.matches.some(match=>match?.isMock===true)))throw new Error("浏览器历史迁移包含无效或演示数据，拒绝生成线上索引");
const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const trackedResult=spawnSync("git",["ls-files","data/prediction-snapshots/*.json","data/purchase-plan-snapshots/*.json"],{cwd:process.cwd(),encoding:"utf8"});
if(trackedResult.status!==0)throw new Error("无法确认快照的 Git 版本，拒绝生成线上索引");
const tracked=new Set(String(trackedResult.stdout||"").split(/\r?\n/).filter(Boolean).map(value=>value.replaceAll("\\","/")));
const allowedPredictionIds=new Set(),predictionDirectory=join(process.cwd(),"data","prediction-snapshots");
for(const name of await readdir(predictionDirectory).catch(()=>[])){
 const relative=`data/prediction-snapshots/${name}`;
 if(!tracked.has(relative)&&!name.startsWith(`${today}_`))continue;
 if(!/^\d{4}-\d{2}-\d{2}_(?:[01]\d|2[0-3])[0-5]\d(?:\.raw)?\.json$/.test(name))continue;
 try{
  const record=JSON.parse(await readFile(join(predictionDirectory,name),"utf8"));
  const snapshotId=String(record.snapshotId||snapshotIdFromFileName(name));
  if(snapshotId)allowedPredictionIds.add(snapshotId);
 }catch{/* 损坏文件不会进入线上索引。 */}
}
const formalSnapshots=formalSourceSnapshots.map(snapshot=>({...snapshot,matches:(snapshot.matches||[]).filter(match=>allowedPredictionIds.has(String(match.selectedSnapshotId||"")))})).filter(snapshot=>snapshot.matches.length);
const snapshotKey=snapshot=>`${snapshot.date}|${snapshot.sourceFetchedAt}|${snapshot.predictionId||"legacy"}`;
const snapshots=Array.from(new Map([...formalSnapshots,...migratedSnapshots].map(snapshot=>[snapshotKey(snapshot),snapshot])).values()).sort((left,right)=>String(right.capturedAt||right.sourceFetchedAt).localeCompare(String(left.capturedAt||left.sourceFetchedAt)));
const allowedPurchaseIds=new Set(),purchaseDirectory=join(process.cwd(),"data","purchase-plan-snapshots");
for(const name of await readdir(purchaseDirectory).catch(()=>[])){
 const relative=`data/purchase-plan-snapshots/${name}`;
 if(!tracked.has(relative)&&!name.startsWith(`${today}_`))continue;
 try{const record=JSON.parse(await readFile(join(purchaseDirectory,name),"utf8"));if(record.snapshotId)allowedPurchaseIds.add(String(record.snapshotId))}catch{/* 损坏文件不会进入线上索引。 */}
}
const purchasePlanSnapshots=(Array.isArray(data.purchasePlanSnapshots)?data.purchasePlanSnapshots:[]).filter(snapshot=>allowedPurchaseIds.has(String(snapshot.snapshotId||"")));
const bundle={schemaVersion:2,generatedAt:new Date().toISOString(),formalSnapshotCount:formalSnapshots.length,migratedSnapshotCount:migratedSnapshots.length,snapshots,resultCache,purchasePlanSnapshots};
await writeFile(bundlePath,`${JSON.stringify(bundle)}\n`,"utf8");
console.log(JSON.stringify({status:"saved",path,bundlePath,days:days.length,matches:days.reduce((sum,day)=>sum+day.matchCount,0),bundleBytes:Buffer.byteLength(JSON.stringify(bundle))}));
