import {spawnSync} from "node:child_process";
import {decisionTargetAt} from "../app/snapshot-decision-policy.js";
import {captureWindow,requestJson} from "./capture-contract.mjs";

const baseUrl=process.env.FOOTBALL_FOCUS_URL||"http://localhost:3000";
const now=Date.now();
const date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(now));
const data=await requestJson(`${baseUrl}/api/sporttery`,{cache:"no-store"});
if(!Array.isArray(data.matches))throw new Error("官方清单未知，不能宣称无到期比赛");
const due=new Map();
for(const match of Array.isArray(data.matches)?data.matches:[]){
 const targetAt=decisionTargetAt(match.salesDate,match.kickoffAt);
 const target=Date.parse(targetAt||"");
 if(match.salesDate!==date||!Number.isFinite(target)||captureWindow(now,targetAt)!=="eligible"||Date.parse(match.kickoffAt)<=now)continue;
 const local=new Date(target+8*60*60*1000),slot=`${String(local.getUTCHours()).padStart(2,"0")}${String(local.getUTCMinutes()).padStart(2,"0")}`;
 due.set(slot,targetAt);
}
const runs=[];
for(const [slot,targetAt] of due){
 const run=spawnSync(process.execPath,["scripts/capture-prediction-snapshot.mjs",slot],{cwd:process.cwd(),encoding:"utf8",env:process.env,timeout:300000});
 if(run.status!==0)throw new Error(run.stderr||run.stdout||`${slot} 快照失败`);
 runs.push({slot,targetAt,output:String(run.stdout||"").trim()});
}
console.log(JSON.stringify({status:runs.length?"processed":"no_due_matches",checkedAt:new Date(now).toISOString(),runs}));
