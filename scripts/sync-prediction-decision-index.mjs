import {mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";

const baseUrl=process.env.FOOTBALL_FOCUS_URL||"http://localhost:3000";
const response=await fetch(`${baseUrl}/api/prediction-snapshots`,{cache:"no-store"});
const data=await response.json().catch(()=>({}));
if(!response.ok)throw new Error(data.error||"盘后快照读取失败");
const days=(data.snapshots||[]).map(snapshot=>({date:snapshot.date,snapshotId:snapshot.snapshotId,matchCount:snapshot.matches?.length||0,matches:(snapshot.matches||[]).map(match=>({officialMatchId:match.officialMatchId,id:match.id,home:match.home,away:match.away,kickoffAt:match.kickoffAt,decisionTargetAt:match.decisionTargetAt,selectedSnapshotId:match.selectedSnapshotId,selectedCapturedAt:match.selectedCapturedAt,decisionPolicy:match.decisionPolicy}))}));
const output={schemaVersion:1,policy:"latest_not_after_official_target_v1",generatedAt:new Date().toISOString(),rules:{weekday:"22:00及以后统一21:30，否则开赛前30分钟",weekend:"23:00及以后统一22:30，否则开赛前30分钟"},days};
const directory=join(process.cwd(),"data","analysis");await mkdir(directory,{recursive:true});
const path=join(directory,"prediction-decision-index.json");await writeFile(path,`${JSON.stringify(output,null,2)}\n`,"utf8");
console.log(JSON.stringify({status:"saved",path,days:days.length,matches:days.reduce((sum,day)=>sum+day.matchCount,0)}));
