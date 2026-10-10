import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import {selectOfficialDecisionRows} from '../app/snapshot-decision-policy.js';

// Use the existing route's projection, not a new model or a live odds request.
const route=await readFile('app/api/prediction-snapshots/route.ts','utf8');
const functionSource=route.slice(route.indexOf('function toSnapshot('),route.indexOf('export async function GET'));
const js=ts.transpileModule(functionSource,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const project=new Function('number','labelFor',js+';return toSnapshot;')(
 value=>Number.isFinite(Number(value))?Number(value):0,
 slot=>`${slot.slice(0,2)}:${slot.slice(2)}批次`,
);
const name='2026-10-05_2130.raw.json';
const raw=JSON.parse(await readFile('data/prediction-snapshots/'+name,'utf8'));
if(raw.immutable!==true||raw.capturedAt!=='2026-10-05T13:17:02.147Z')throw new Error('Unexpected source');
const source=project(raw,name);
const rows=selectOfficialDecisionRows([source]);
if(rows.length!==7)throw new Error('Expected seven original predictions');
const matches=rows.map(row=>({...row.match,decisionTargetAt:row.targetAt,selectedSnapshotId:raw.snapshotId,selectedScheduledAt:row.scheduledAt,selectedCapturedAt:row.capturedAt,decisionPolicy:'latest_not_after_official_target_v1'}));
const snapshot={snapshotId:'2026-10-05-official-decision-v1',immutable:true,schemaVersion:3,predictionId:'decision-2026-10-05-v1',date:'2026-10-05',scheduledAt:'',capturedAt:raw.capturedAt,sourceFetchedAt:raw.capturedAt,upstreamUpdatedAt:raw.capturedAt,decisionTiming:'pre_match',scheduleLabel:'每日正式复盘 · 7场（按规定决策时点合并）',storageOrigin:'server',matches};
// Retain every unrelated published record exactly; update only this missing day.
for(const path of ['data/generated-prediction-snapshot-index.json','data/analysis/prediction-decision-index.json']){
 const data=JSON.parse(execFileSync('git',['show','HEAD:'+path],{encoding:'utf8',maxBuffer:30*1024*1024}));
 if(path.includes('generated-')){
  data.snapshots=data.snapshots.filter(row=>row.snapshotId!==snapshot.snapshotId).concat(snapshot).sort((a,b)=>String(b.capturedAt||b.sourceFetchedAt).localeCompare(String(a.capturedAt||a.sourceFetchedAt)));
  data.formalSnapshotCount=data.snapshots.filter(row=>row.storageOrigin==='server').length;
 }else{
  const day={date:snapshot.date,snapshotId:snapshot.snapshotId,matchCount:matches.length,matches:matches.map(({officialMatchId,id,home,away,kickoffAt,decisionTargetAt,selectedSnapshotId,selectedScheduledAt,selectedCapturedAt,decisionPolicy})=>({officialMatchId,id,home,away,kickoffAt,decisionTargetAt,selectedSnapshotId,selectedScheduledAt,selectedCapturedAt,decisionPolicy}))};
  data.days=data.days.filter(row=>row.date!==snapshot.date).concat(day);
 }
 data.generatedAt=new Date().toISOString();
 await writeFile(path,JSON.stringify(data,path.includes('/analysis/')?null:undefined,path.includes('/analysis/')?2:undefined)+'\n');
}
console.log('Restored October 5: 7 unchanged original predictions; retained all other published days.');
