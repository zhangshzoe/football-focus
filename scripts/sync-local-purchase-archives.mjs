// Append genuine local immutable archives without replacing published history.
import {readdir,readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';

const source=resolve(process.argv[2]||'../football-focus');
const target=process.cwd();
if(source===target)throw new Error('Source must be a separate checkout');
const bundlePath=join(target,'data/generated-prediction-snapshot-index.json');
const bundle=JSON.parse(await readFile(bundlePath,'utf8'));
const rows=new Map((bundle.purchasePlanSnapshots||[]).map(row=>[row.snapshotId,row]));
const added=[],indexed=[];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const project=r=>({snapshotId:r.snapshotId,scheduledAt:r.scheduledAt,capturedAt:r.capturedAt,startedAt:r.startedAt,completedAt:r.completedAt,captureTiming:r.captureTiming,includedInStrictEvaluation:r.includedInStrictEvaluation,qualityStatus:r.qualityStatus,cutoffStatus:r.cutoffStatus,sourceCoverage:r.sourceCoverage,sourceFetchedAt:r.sourceFetchedAt,predictionId:r.predictionId,contentHash:r.contentHash,previousSnapshotId:r.previousSnapshotId,planSet:{...r.planSet,snapshotId:r.snapshotId,contentHash:r.contentHash}});
await mkdir(join(target,'data/purchase-plan-snapshots'),{recursive:true});
for(const name of (await readdir(join(source,'data/purchase-plan-snapshots'))).filter(n=>n.endsWith('.json')).sort()){
 const from=join(source,'data/purchase-plan-snapshots',name),to=join(target,'data/purchase-plan-snapshots',name);
 const bytes=await readFile(from),r=JSON.parse(bytes);
 if(r.recordType!=='purchase-plan-snapshot'||r.immutable!==true||!r.snapshotId||!r.planSet?.plans?.length)continue;
 if(r.predictionInputs?.some(row=>row.isMock===true))throw new Error(`Mock inputs: ${name}`);
 let existing;try{existing=await readFile(to)}catch(error){if(error.code!=='ENOENT')throw error;}
 // Published archives take precedence; local historical edits are out of scope.
 if(existing)continue;
 if(!existing){await copyFile(from,to);if(hash(await readFile(to))!==hash(bytes))throw new Error(`Copy mismatch: ${name}`);added.push(name);}
 const row=rows.get(r.snapshotId);
 if(row?.contentHash&&r.contentHash&&row.contentHash!==r.contentHash)throw new Error(`Snapshot identity conflict: ${r.snapshotId}`);
 if(!row){rows.set(r.snapshotId,project(r));indexed.push(r.snapshotId);}
}
if(indexed.length){bundle.purchasePlanSnapshots=[...rows.values()].sort((a,b)=>String(b.capturedAt||'').localeCompare(String(a.capturedAt||'')));bundle.generatedAt=new Date().toISOString();await writeFile(bundlePath,JSON.stringify(bundle)+'\n');}
console.log(JSON.stringify({added,indexed,total:rows.size}));
