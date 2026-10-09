import test from "node:test";
import assert from "node:assert/strict";
import {captureWindow,captureEvidence,assertOfficialInput,assertCoverage,requestJson,selectSellingInputs,changedOfficialOdds} from "../scripts/capture-contract.mjs";
import {selectOfficialDecisionRows,decisionTargetAt} from "../app/snapshot-decision-policy.js";
import {mkdtemp,readFile,readdir,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {writePurchaseAttempt} from "../scripts/purchase-capture-attempt.mjs";
import {recommendationComplete,recommendationLabel} from "../app/purchase-snapshot-status.js";
const target="2026-10-09T17:00:00+08:00", t=Date.parse(target);
test("daily recommendation completeness and labels do not pretend strict eligibility",()=>{
 assert.equal(recommendationComplete({sourceCoverage:{eligible:10,predicted:9}}),false);
 assert.equal(recommendationComplete({sourceCoverage:{eligible:10,predicted:10},cutoffStatus:"unknown",includedInStrictEvaluation:false}),true);
 assert.match(recommendationLabel({scheduledTime:"21:00",captureTiming:"delayed",qualityStatus:"partial",cutoffStatus:"unknown"}),/21:00推荐快照 · 延迟采集 · 部分场次 · 截止时间未知/);
});
test("partial batch retries append improved coverage and never overwrite the first snapshot",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"football-purchase-recovery-"));
 try{
  const run=partial=>spawnSync(process.execPath,["--import",new URL("./fixtures/capture-runtime.mjs",import.meta.url).href,fileURLToPath(new URL("../scripts/capture-purchase-plan-snapshot.mjs",import.meta.url)),"--slot=2100"],{cwd:directory,encoding:"utf8",env:{...process.env,TEST_CAPTURE_NOW:String(Date.parse("2026-10-09T21:20:00+08:00")),TEST_CAPTURE_COMPLETE:"1",TEST_CAPTURE_MISSING_CUTOFF:"1",TEST_CAPTURE_PARTIAL:partial?"1":"0"}});
  const first=run(true);assert.equal(first.status,0,first.stderr);const initial=JSON.parse(first.stdout);const before=await readFile(initial.output,"utf8");
  const same=run(true);assert.equal(same.status,0,same.stderr);assert.equal(JSON.parse(same.stdout).reason,"unchanged-partial-snapshot");
  const second=run(false);assert.equal(second.status,0,second.stderr);const recovered=JSON.parse(second.stdout);assert.equal(recovered.status,"saved");assert.notEqual(recovered.output,initial.output);
  assert.equal(await readFile(initial.output,"utf8"),before);assert.equal(JSON.parse(await readFile(recovered.output,"utf8")).sourceCoverage.predicted,5);
  assert.equal(JSON.parse(run(false).stdout).reason,"daily-snapshot-exists");
 }finally{await rm(directory,{recursive:true,force:true});}
});
test("purchase supports pre-window but cannot backfill a closed or next-day batch",()=>{
 assert.equal(captureWindow(t-15*60000,target,{purchase:true,preWindow:true}),"eligible");
 assert.equal(captureWindow(t-15*60000-1,target,{purchase:true,preWindow:true}),"before-window");
 assert.equal(captureWindow(t-60000,target,{purchase:true}),"before-window");
 assert.equal(captureWindow(t+100*60000,target,{purchase:true}),"eligible");
 assert.equal(captureWindow(t+101*60000,target,{purchase:true}),"window-closed");
 assert.equal(captureWindow(t+24*3600000,target,{purchase:true}),"window-closed");
});
test("due capture accepts only genuine target-minus-15 through target",()=>{
 assert.equal(captureWindow(t-15*60000,target),"eligible");
 assert.equal(captureWindow(t,target),"eligible");
 assert.equal(captureWindow(t+1,target),"window-closed");
});
const match={id:"001",matchId:"123",officialMatchId:"123",salesDate:"2026-10-09",kickoffAt:"2026-10-09T18:00:00+08:00",home:"甲",away:"乙",matchStatus:"Selling",marketEligibility:{had:{qualification:"qualified",salesStatus:"Selling",cutoffAt:"2026-10-09T17:59:00+08:00"}}};
test("real completion determines strict eligibility, not the scheduled timestamp",()=>{
 const timely=captureEvidence(target,new Date(t-60000).toISOString(),new Date(t-1).toISOString(),new Date(t).toISOString(),[match]);
 assert.equal(timely.includedInStrictEvaluation,true);
 const late=captureEvidence(target,new Date(t-60000).toISOString(),new Date(t).toISOString(),new Date(t+1).toISOString(),[match]);
 assert.equal(late.captureTiming,"delayed");assert.equal(late.includedInStrictEvaluation,false);
 const snapshot={...late,date:match.salesDate,matches:[match],scheduledAt:decisionTargetAt(match.salesDate,match.kickoffAt)};
 assert.deepEqual(selectOfficialDecisionRows([snapshot]),[]);
});
test("official input rejects stale, mock, unknown deadlines and already started fixtures",()=>{
 const data={fetchedAt:new Date(t).toISOString()};
 assert.doesNotThrow(()=>assertOfficialInput(data,[match],t));
 assert.throws(()=>assertOfficialInput({},[match],t),/过期/);
 assert.throws(()=>assertOfficialInput({fetchedAt:new Date(t-300001).toISOString()},[match],t),/过期/);
 assert.throws(()=>assertOfficialInput(data,[{...match,isMock:true}],t),/身份/);
 assert.throws(()=>assertOfficialInput(data,[{...match,marketEligibility:{}}],t),/可售.*玩法/);
 assert.throws(()=>assertOfficialInput(data,[{...match,marketEligibility:{had:{qualification:"qualified",salesStatus:"Selling",cutoffAt:null}}}],t),error=>error.code==="OFFICIAL_CUTOFF_UNAVAILABLE"&&error.officialMatchId==="123");
 assert.throws(()=>assertOfficialInput(data,[{...match,kickoffAt:target}],t),/开赛/);
});
test("partial or duplicate predictions cannot be marked complete",()=>{
 assert.doesNotThrow(()=>assertCoverage([match],[{officialMatchId:"123"}]));
 assert.throws(()=>assertCoverage([match],[]),/不完整/);
 assert.throws(()=>assertCoverage([match],[{officialMatchId:"123"},{officialMatchId:"123"}]),/不完整/);
});
test("invalid upstream JSON remains a failure, not an empty success",async()=>{
 await assert.rejects(requestJson("data:text/plain,not-json"),/非法 JSON/);
});
test("actual raw writer saves and reads immutable evidence; duplicate invocation does not add supplements",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"football-capture-test-"));
 try {
  const script=fileURLToPath(new URL("../scripts/capture-prediction-snapshot.mjs",import.meta.url));
  const runtime=new URL("./fixtures/capture-runtime.mjs",import.meta.url).href;
  const run=()=>spawnSync(process.execPath,["--import",runtime,script,"2130"],{cwd:directory,encoding:"utf8",env:{...process.env,TEST_CAPTURE_NOW:String(Date.parse("2026-10-09T21:15:00+08:00"))}});
  const first=run();assert.equal(first.status,0,first.stderr);
  assert.equal(JSON.parse(first.stdout).status,"saved");
  const path=join(directory,"data","prediction-snapshots","2026-10-09_2130.raw.json");
  const before=await readFile(path,"utf8"),record=JSON.parse(before);
  assert.equal(record.captureTiming,"on-time");assert.equal(record.includedInStrictEvaluation,true);
  assert.equal(record.completedAt,"2026-10-09T13:15:00.000Z");
  assert.equal(JSON.parse(run().stdout).status,"exists");
  assert.equal(await readFile(path,"utf8"),before);
  assert.equal((await readdir(join(directory,"data","prediction-snapshots"))).length,1);
 } finally {await rm(directory,{recursive:true,force:true});}
});
test("actual purchase entry accepts pre-window and safely skips unavailable tickets",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"football-purchase-test-"));
 try {
  const run=spawnSync(process.execPath,["--import",new URL("./fixtures/capture-runtime.mjs",import.meta.url).href,fileURLToPath(new URL("../scripts/capture-purchase-plan-snapshot.mjs",import.meta.url)),"--pre-window"],{cwd:directory,encoding:"utf8",env:{...process.env,TEST_CAPTURE_NOW:String(t-15*60000)}});
  assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(run.stdout).reason,"no-eligible-plans");
  assert.equal((await readdir(join(directory,"data","purchase-plan-snapshots"))).length,0);
 } finally {await rm(directory,{recursive:true,force:true});}
});

test("both purchase slots persist failure evidence when all official matches have stopped",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"football-purchase-failure-"));
 try{
  for(const slot of ["1700","2100"]){
   const scheduledAt=`2026-10-09T${slot==="1700"?"17:00":"21:00"}:00+08:00`;
   const run=spawnSync(process.execPath,["--import",new URL("./fixtures/capture-runtime.mjs",import.meta.url).href,fileURLToPath(new URL("../scripts/capture-purchase-plan-snapshot.mjs",import.meta.url)),`--slot=${slot}`,"--pre-window"],{cwd:directory,encoding:"utf8",env:{...process.env,TEST_CAPTURE_NOW:String(Date.parse(scheduledAt)-15*60000),TEST_CAPTURE_CLOSED:"1"}});
   assert.equal(run.status,1,run.stderr);
   assert.equal(JSON.parse(run.stderr).code,"NO_ELIGIBLE_OFFICIAL_MATCHES");
   const names=(await readdir(join(directory,"data","capture-attempts"))).filter(name=>name.includes(`purchase_${slot}`));
   assert.equal(names.length,1);
   const record=JSON.parse(await readFile(join(directory,"data","capture-attempts",names[0]),"utf8"));
   assert.equal(record.status,"failed");assert.equal(record.scheduledAt,scheduledAt);
  }
  assert.equal((await readdir(join(directory,"data","purchase-plan-snapshots"))).length,0);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test("two stopped matches never block ten fresh selling matches with unknown cutoffs",()=>{
 assert.deepEqual(changedOfficialOdds({had:[2,3,4],total:[4,5]},{total:[4,5],had:[2,3,4]}),[]);
 assert.deepEqual(changedOfficialOdds({had:[2,3,4]},{had:[2.1,3,4]}),["had"]);
 const selling={...match,marketEligibility:{had:{qualification:"qualified",salesStatus:"Selling",cutoffAt:null}}};
 const data={fetchedAt:new Date(t).toISOString(),matches:[{...selling,matchStatus:"Stopped"},{...selling,kickoffAt:target},...Array.from({length:10},(_,index)=>({...selling,matchId:String(index),officialMatchId:String(index)}))]};
 const selected=selectSellingInputs(data,"2026-10-09",t);
 assert.equal(selected.matches.length,10);assert.equal(selected.excluded.length,2);
 assert.equal(selected.matches[0].marketEligibility.had.cutoffAt,null);
 assert.equal(selected.matches[0].marketEligibility.had.cutoffStatus,"unknown");
 const expired={...selling,marketEligibility:{had:{qualification:"qualified",salesStatus:"Selling",cutoffAt:"2026-10-09T16:00:00+08:00"}}};
 assert.equal(selectSellingInputs({...data,matches:[expired]},"2026-10-09",t).matches.length,0);
 assert.throws(()=>assertOfficialInput({...data,fetchedAt:new Date(t-300001).toISOString()},[selling],t,{allowMissingCutoff:true}),/过期/);
});

test("current capture with unknown cutoff saves actual-time record excluded from strict evaluation",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"football-current-selling-"));
 try{
  const run=spawnSync(process.execPath,["--import",new URL("./fixtures/capture-runtime.mjs",import.meta.url).href,fileURLToPath(new URL("../scripts/capture-purchase-plan-snapshot.mjs",import.meta.url)),"--current"],{cwd:directory,encoding:"utf8",env:{...process.env,TEST_CAPTURE_NOW:String(t+2*3600000),TEST_CAPTURE_COMPLETE:"1",TEST_CAPTURE_MISSING_CUTOFF:"1"}});
  assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout);assert.equal(result.status,"saved");
  const record=JSON.parse(await readFile(result.output,"utf8"));
  assert.equal(record.scheduledAt,new Date(t+2*3600000).toISOString());assert.equal(record.cutoffStatus,"unknown");
  assert.equal(record.includedInStrictEvaluation,false);
  assert.equal(record.planSet.plans.flatMap(plan=>plan.items||[])[0].cutoffAt,null);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test("attempt writes are separate immutable records with read-back evidence",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"football-purchase-attempt-"));
 try{
  const args={date:"2026-10-09",slot:"1700",scheduledAt:target,startedAt:target,status:"failed",code:"OFFICIAL_CUTOFF_UNAVAILABLE"};
  const a=await writePurchaseAttempt(args,directory),before=await readFile(a.path,"utf8");
  const b=await writePurchaseAttempt(args,directory);
  assert.notEqual(a.path,b.path);assert.equal(await readFile(a.path,"utf8"),before);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test("17 and 21 purchase writers save independent batches and never overwrite them",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"football-purchase-success-"));
 try{
  for(const slot of ["1700","2100"]){
   const scheduledAt=`2026-10-09T${slot==="1700"?"17:00":"21:00"}:00+08:00`;
   const run=()=>spawnSync(process.execPath,["--import",new URL("./fixtures/capture-runtime.mjs",import.meta.url).href,fileURLToPath(new URL("../scripts/capture-purchase-plan-snapshot.mjs",import.meta.url)),`--slot=${slot}`,"--pre-window"],{cwd:directory,encoding:"utf8",env:{...process.env,TEST_CAPTURE_NOW:String(Date.parse(scheduledAt)-15*60000),TEST_CAPTURE_COMPLETE:"1"}});
   const first=run();assert.equal(first.status,0,first.stderr);assert.equal(JSON.parse(first.stdout).status,"saved");
   const path=join(directory,"data","purchase-plan-snapshots",`2026-10-09_${slot}.purchase.json`),before=await readFile(path,"utf8"),record=JSON.parse(before);
   assert.equal(record.scheduledAt,scheduledAt);assert.equal(record.captureTiming,"on-time");
   assert.ok(record.planSet.plans.some(plan=>plan.items?.length));
   assert.equal(JSON.parse(run().stdout).reason,"daily-snapshot-exists");
   assert.equal(await readFile(path,"utf8"),before);
  }
  assert.equal((await readdir(join(directory,"data","purchase-plan-snapshots"))).length,2);
 }finally{await rm(directory,{recursive:true,force:true});}
});
