import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';
test('GitHub snapshot API preserves baseline and exposes verified durable read status in all views',async()=>{
 const original=readFileSync(new URL('../app/api/prediction-snapshots/route.ts',import.meta.url),'utf8');
 const code=original.replace(/^import .*;\r?$/gm,'').replace(/^const bundledIndexFiles=.*;\r?$/m,'const bundledIndexFiles={fixture:fixtureIndex};');
 const compiled=transpileModule(code,{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText;
 const fixtureIndex={snapshots:[{snapshotId:'baseline',date:'2026-10-31',capturedAt:'2026-10-31T09:00:00Z',matches:[]}],resultCache:{},purchasePlanSnapshots:[]};
 const before=JSON.stringify(fixtureIndex);
 for(const status of ['verified','degraded-baseline-only']){
  const scope={exports:{},fixtureIndex,process:{cwd:()=>'/isolated'},join:(...x)=>x.join('/'),readFile:async()=>{throw Error('no disk')},readdir:async()=>[],NextResponse:{json:x=>x},recoveredResults:{results:[]},deduplicatePurchasePlans:x=>x,selectOfficialDecisionRows:()=>[],buildArchiveRecoverySnapshots:()=>[],readHandoffProjection:async baseline=>({index:baseline,status,error:status==='verified'?null:'PERSISTENT_HISTORY_UNVERIFIED'})};
  new Function(...Object.keys(scope),compiled)(...Object.values(scope));
  for(const view of ['', 'recommendations','sources']){
   const out=await scope.exports.GET(new Request('https://fixture.invalid/?view='+view));
   assert.equal(out.error,undefined);assert.equal(out.persistenceStatus,status);assert.equal(out.persistenceError,status==='verified'?null:'PERSISTENT_HISTORY_UNVERIFIED');
   assert.deepEqual(out.snapshots,view==='recommendations'?[]:fixtureIndex.snapshots);
  }
 }
 assert.equal(JSON.stringify(fixtureIndex),before);
});
