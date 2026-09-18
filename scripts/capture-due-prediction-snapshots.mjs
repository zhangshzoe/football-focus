import {spawnSync} from "node:child_process";
import {decisionTargetAt} from "../app/snapshot-decision-policy.js";

const baseUrl=process.env.FOOTBALL_FOCUS_URL||"http://localhost:3000";
const now=Date.now(),windowMs=10*60*1000;
const response=await fetch(`${baseUrl}/api/sporttery`,{cache:"no-store"});
const data=await response.json().catch(()=>({}));
if(!response.ok)throw new Error(data.error||"体彩比赛数据读取失败");
const due=new Map();
for(const match of Array.isArray(data.matches)?data.matches:[]){
 const targetAt=decisionTargetAt(match.salesDate,match.kickoffAt);
 const target=Date.parse(targetAt||"");
 if(!Number.isFinite(target)||now<target||now-target>=windowMs)continue;
 const local=new Date(target+8*60*60*1000),slot=`${String(local.getUTCHours()).padStart(2,"0")}${String(local.getUTCMinutes()).padStart(2,"0")}`;
 due.set(slot,targetAt);
}
const runs=[];
for(const [slot,targetAt] of due){
 const run=spawnSync(process.execPath,["scripts/capture-prediction-snapshot.mjs",slot],{cwd:process.cwd(),encoding:"utf8",env:process.env});
 if(run.status!==0)throw new Error(run.stderr||run.stdout||`${slot} 快照失败`);
 runs.push({slot,targetAt,output:String(run.stdout||"").trim()});
}
console.log(JSON.stringify({status:runs.length?"processed":"no_due_matches",checkedAt:new Date(now).toISOString(),runs}));
