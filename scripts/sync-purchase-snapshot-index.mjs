import {readFile,writeFile} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export async function appendPurchaseSnapshot(root,name) {
  if(!name || name!==basename(name) || !/^\d{4}-\d{2}-\d{2}_.*\.purchase\.json$/.test(name))throw new Error('Invalid purchase snapshot filename');
  const rawPath=join(root,'data','purchase-plan-snapshots',name);
  const rawText=await readFile(rawPath,'utf8'),record=JSON.parse(rawText);
  if(record.recordType!=='purchase-plan-snapshot'||record.immutable!==true||!record.snapshotId||!record.contentHash||!record.predictionId||!record.inputHash||!Number.isFinite(Date.parse(record.capturedAt))||!Number.isFinite(Date.parse(record.completedAt))||!Array.isArray(record.planSet?.plans)||!record.planSet.plans.length)throw new Error('Incomplete immutable purchase record');
  if(record.predictionInputs?.some(input=>input.modelInput?.isMock===true)||record.planSet.plans.some(plan=>plan.items?.some(item=>item.isMock===true)))throw new Error('Mock input rejected');
  const indexPath=join(root,'data','generated-prediction-snapshot-index.json');
  const bundle=JSON.parse(await readFile(indexPath,'utf8'));
  if(!Array.isArray(bundle.purchasePlanSnapshots))throw new Error('Existing purchase index missing');
  const keys=['snapshotId','scheduledAt','capturedAt','startedAt','completedAt','captureTiming','includedInStrictEvaluation','qualityStatus','cutoffStatus','sourceCoverage','sourceFetchedAt','predictionId','contentHash','previousSnapshotId'];
  const entry=Object.fromEntries(keys.filter(key=>record[key]!==undefined).map(key=>[key,record[key]]));
  entry.planSet={...record.planSet,snapshotId:record.snapshotId,contentHash:record.contentHash};
  const prior=bundle.purchasePlanSnapshots.find(item=>item.snapshotId===entry.snapshotId);
  if(prior){if(JSON.stringify(prior)!==JSON.stringify(entry))throw new Error('Existing immutable entry differs');return {status:'unchanged',snapshotId:entry.snapshotId};}
  const originalHistory=JSON.stringify({...bundle,generatedAt:undefined});
  const updated={...bundle,generatedAt:new Date().toISOString(),purchasePlanSnapshots:[entry,...bundle.purchasePlanSnapshots].sort((a,b)=>String(b.capturedAt||'').localeCompare(String(a.capturedAt||'')))};
  await writeFile(indexPath,JSON.stringify(updated)+'\n','utf8');
  const saved=JSON.parse(await readFile(indexPath,'utf8'));
  const preserved={...saved,generatedAt:undefined,purchasePlanSnapshots:saved.purchasePlanSnapshots.filter(item=>item.snapshotId!==entry.snapshotId)};
  // Restore original order for the integrity comparison, without rewriting any history.
  preserved.purchasePlanSnapshots=bundle.purchasePlanSnapshots.map(old=>preserved.purchasePlanSnapshots.find(item=>item.snapshotId===old.snapshotId));
  if(JSON.stringify(preserved)!==originalHistory || await readFile(rawPath,'utf8')!==rawText)throw new Error('History or immutable source changed');
  return {status:'saved',snapshotId:entry.snapshotId,purchaseCount:saved.purchasePlanSnapshots.length,rawHash:createHash('sha256').update(rawText).digest('hex'),historyPreserved:true};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await appendPurchaseSnapshot(process.cwd(),process.argv[2])));
