import {spawnSync} from "node:child_process";
import {decisionTargetAt} from "../app/snapshot-decision-policy.js";
import {runCapture} from "./capture-attempts.mjs";

const baseUrl=process.env.FOOTBALL_FOCUS_URL||"http://localhost:3000";
const windowMs=15*60*1000;
const result=await runCapture({kind:"dispatcher",slot:"poll"},async audit=>{
audit.stage="official-source";
const response=await fetch(`${baseUrl}/api/sporttery`,{cache:"no-store",signal:AbortSignal.timeout(30000)});
const data=await response.json().catch(()=>({}));
if(!response.ok)throw new Error(data.error||"体彩比赛数据读取失败");
const due=new Map();
const now=Date.now();
audit.sourceFetchedAt=data.fetchedAt||null;
audit.officialManifest=(data.matches||[]).filter(m=>!m.isMock&&m.officialMatchId).map(m=>({officialMatchId:String(m.officialMatchId),salesDate:m.salesDate,kickoffAt:m.kickoffAt,home:m.home,away:m.away,league:m.league}));
for(const match of Array.isArray(data.matches)?data.matches:[]){
 const targetAt=decisionTargetAt(match.salesDate,match.kickoffAt);
 const target=Date.parse(targetAt||"");
 if(!Number.isFinite(target)||now>=target||target-now>windowMs)continue;
 const local=new Date(target+8*60*60*1000),slot=`${String(local.getUTCHours()).padStart(2,"0")}${String(local.getUTCMinutes()).padStart(2,"0")}`;
 due.set(slot,targetAt);
}
const runs=[];
for(const [slot,targetAt] of due){
 if(Date.now()>=Date.parse(targetAt)) {runs.push({slot,targetAt,status:"late",reason:"启动前已越过决策时点"});continue;}
 const run=spawnSync(process.execPath,["scripts/capture-prediction-snapshot.mjs",slot],{cwd:process.cwd(),encoding:"utf8",env:process.env});
 runs.push({slot,targetAt,status:run.status===0?"processed":"failed",output:String(run.stdout||"").trim(),reason:run.status!==0?String(run.stderr||`${slot} 快照失败`).slice(0,1000):undefined});
}
const failed=runs.some(run=>run.status==="failed");
audit.stage="dispatch-complete";
return {status:failed?"failed":runs.length?"processed":"no_due_matches",outcome:failed?"failed":runs.length?"processed":"no_due_matches",checkedAt:new Date(now).toISOString(),runs};
});
console.log(JSON.stringify(result));
if(result.status==="failed")process.exitCode=1;
