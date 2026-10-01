import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readdir,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {runCapture} from "../scripts/capture-attempts.mjs";
import {compactCaptureAttempts,purchaseCaptureState} from "../app/capture-health.js";
import {mergePurchaseBatches,collectEarlierPurchasePlans} from "../app/purchase-batch-policy.js";
import {selectRecommendationPortfolio} from "../app/recommendation-policy.js";
import {comparePurchaseSlots} from "../app/slot-comparison.js";
import {comparePredictionSlots} from "../app/model-evaluation.js";
import {generatePurchasePlans,verifyPurchasePlanCompletion,MARKET_META} from "../app/purchase-plan-engine.js";
import {assertCompletePurchaseEvaluation} from "../app/server-official-evidence.js";
import {loadPurchaseHistorySources} from "../app/purchase-history-source.js";
const date="2026-10-01",time=h=>date+"T"+h+":00+08:00";
const leg=id=>({officialMatchId:id,salesDate:date,league:"测试",market:"had",picks:[{pick:"胜",probability:80,odd:2}]});
const plan=(id,ids)=>({id,status:"pending",stake:2,items:ids.map(leg)});
const set=(slot,plans=[])=>({snapshotId:"batch-"+slot,date,scheduledTime:slot,generatedAt:time(slot),decisionPolicy:"test",baseModelVersion:"test",calibrationVersion:"none",plans,decisionSummary:{evaluated:true,noBet:!plans.length}});

test("same-batch conflicts include probability changes but not settlement updates",()=>{
 const a=set("17:00",[plan("a",["1","2"])]),settled=structuredClone(a);settled.plans[0].status="won";settled.plans[0].items[0].actual="胜";
 assert.equal(mergePurchaseBatches([a,settled]).planSets.length,1);
 const conflict=structuredClone(a);conflict.plans[0].items[0].picks[0].probability=75;
 assert.equal(mergePurchaseBatches([a,conflict]).planSets.length,0);
 assert.equal(collectEarlierPurchasePlans([a,{...conflict,date:"2026-09-30"}],date).status,"verified");
});
test("duplicate definition identities cannot double-charge the returned portfolio",()=>{
 const a=plan("same",["1","2"]),b=plan("same",["3","4"]);
 const r=selectRecommendationPortfolio([a,b],{policy:{dailyBudget:2,maxTickets:1}});
 assert.equal(r.inputState,"invalid");assert.equal(r.portfolio.totalStake,0);
 const exact=selectRecommendationPortfolio([a,a]);assert.equal(exact.plans.length,1);assert.equal(exact.portfolio.totalStake,2);
});
test("risk screening tries diversified fallback and freezes only the selected alternative",()=>{
 const a=plan("A",["1","2"]),b={...plan("B",["1","2"]),candidateAlternatives:[plan("B",["3","4"])]};
 const r=selectRecommendationPortfolio([a,b],{policy:{maxTickets:2,dailyBudget:4}});
 assert.equal(r.selected,2);assert.equal(r.portfolio.totalStake,4);assert.equal(r.portfolio.duplicateTickets,0);
 assert.equal(r.plans.find(p=>p.id==="B").items[0].officialMatchId,"3");assert.equal(r.plans.some(p=>p.candidateAlternatives),false);
 const savedValidation=selectRecommendationPortfolio([b].map(p=>({...p,candidateAlternatives:[]})),{policy:{dailyBudget:0}});
 assert.equal(savedValidation.selected,0);
});
test("fixture ticket counts apply across the prior and current batch",()=>{
 const r=selectRecommendationPortfolio([plan("B",["1","3"])],{priorPlans:[plan("A",["1","2"])],policy:{maxTicketsPerFixture:1}});
 assert.equal(r.selected,0);assert.equal(r.rejected.B.code,"fixture_ticket_limit");
 assert.equal(selectRecommendationPortfolio([],{priorPlans:[{...plan("A",["1","2"]),stake:8}]}).priorState,"invalid");
});
test("sellable markets missing a complete vector cannot become an evaluated no-bet",()=>{
 const reports=Array.from({length:3},(_,i)=>({id:"m"+i,officialMatchId:String(i+1),officialMappingStatus:"verified",salesDate:date,kickoffAt:time("23:00"),sourceFetchedAt:time("17:00"),home:"H",away:"A",hadProbabilities:[34,33,33].map((probability,i)=>({score:MARKET_META.had.labels[i],probability}))}));
 const officialMatches=reports.map(r=>({...r,matchStatus:"Selling",marketOdds:{"胜平负":[1.1,1.1,1.1],"总进球数":Array(8).fill(8)},marketEligibility:Object.fromEntries(["had","total"].map(k=>[MARKET_META[k].name,{qualification:"qualified",salesStatus:"Selling",marketCode:MARKET_META[k].code,allowedPassCounts:[2,3],cutoffAt:time("22:50")}]))}));
 const r=generatePurchasePlans({date,generatedAt:time("17:00"),reports,officialMatches});
 assert.equal(r.decisionSummary.noBet,false);assert.equal(r.decisionSummary.coverage.missingEligibleCount,3);
 assert.deepEqual(r.decisionSummary.coverage.fixtures[0].missingMarkets,["total"]);
 assert.throws(()=>assertCompletePurchaseEvaluation(r),/覆盖不完整/);
 const selectedReports=reports.map(report=>({...report,hadProbabilities:[80,10,10].map((probability,i)=>({score:MARKET_META.had.labels[i],probability}))}));
 const selectedMatches=officialMatches.map(match=>({...match,marketOdds:{...match.marketOdds,"胜平负":[3,4,4]}}));
 const partial=generatePurchasePlans({date,generatedAt:time("17:00"),reports:selectedReports,officialMatches:selectedMatches});
 assert.ok(partial.plans.some(plan=>plan.status!=="unavailable"));
 assert.equal(partial.decisionSummary.evaluated,false);
 assert.throws(()=>assertCompletePurchaseEvaluation(partial),/覆盖不完整/);
 assert.equal(assertCompletePurchaseEvaluation({decisionSummary:{evaluated:true,coverage:{missingEligibleCount:0}}}),undefined);
});

test("current early-batch history merges fresh disk and cloud stake without relying on a stale bundle",async()=>{
 const snapshot=(id,fixtureIds)=>({snapshotId:id,capturedAt:time("17:00"),planSet:{...set("17:00",[plan(id,fixtureIds)]),snapshotId:id}});
 const bundled=snapshot("bundled",["1","2"]),disk=snapshot("fresh-disk",["3","4"]),cloud=snapshot("fresh-cloud",["5","6"]);
 const records=await loadPurchaseHistorySources({bundled:[bundled],readDisk:async()=>[bundled,disk],readCloud:async()=>[cloud]});
 assert.equal(records.length,3);
 const earlier=collectEarlierPurchasePlans(records.map(record=>record.planSet),date);
 assert.equal(earlier.status,"verified");assert.equal(earlier.recordCount,3);assert.equal(earlier.plans.length,3);
 const assessment=selectRecommendationPortfolio([plan("late",["7","8"])],{priorPlans:earlier.plans,policy:{dailyBudget:6}});
 assert.equal(assessment.selected,0);assert.equal(assessment.portfolio.totalStake,0);
 await assert.rejects(loadPurchaseHistorySources({bundled:[bundled],readDisk:async()=>[],readCloud:async()=>{throw new Error("cloud storage unavailable");}}),/cloud storage unavailable/);
});
test("source history rejects conflicting frozen same-ID content but permits settlement-only updates",async()=>{
 const original={snapshotId:"same-immutable-1700",capturedAt:time("17:00"),planSet:{...set("17:00",[plan("a",["1","2"]),plan("b",["3","4"])]),inputHash:"original-input"}};
 const settled=structuredClone(original);settled.planSet.plans[0].status="won";settled.planSet.plans[0].items[0].actual="胜";
 const load=record=>loadPurchaseHistorySources({bundled:[original],readDisk:async()=>[record],readCloud:async()=>[]});
 const merged=await load(settled);assert.equal(merged.length,1);assert.equal(merged[0].planSet.plans[0].status,"won");
 const earlier=collectEarlierPurchasePlans(merged.map(row=>row.planSet),date);
 assert.equal(earlier.status,"verified");assert.equal(earlier.plans.reduce((sum,p)=>sum+p.stake,0),4);
 for(const change of [row=>row.planSet.plans.pop(),row=>row.planSet.plans[0].items[0].picks[0].probability=75,row=>row.planSet.inputHash="altered-input",row=>row.planSet.plans[0].stake=1]){
  const conflict=structuredClone(original);change(conflict);
  await assert.rejects(load(conflict),/历史快照投注原始内容冲突/);
 }
 assert.equal(original.planSet.plans.length,2);assert.equal(original.planSet.plans[0].status,"pending");
});
test("capture completion after sales cutoff rejects a previously valid frozen ticket",()=>{
 const p=plan("a",["1"]),official=[{officialMatchId:"1",salesDate:date,kickoffAt:time("23:00"),matchStatus:"Selling",marketOdds:{"胜平负":[2,3,4]},marketEligibility:{"胜平负":{qualification:"qualified",salesStatus:"Selling",allowedPassCounts:[1],cutoffAt:time("17:00")}}}];
 assert.equal(verifyPurchasePlanCompletion({plans:[p]},official,time("16:59")),true);
 assert.throws(()=>verifyPurchasePlanCompletion({plans:[p]},official,time("17:01")),/停售/);
});
test("unknown and delayed batch evidence never masquerades as a strict cash pair",()=>{
 const early=set("17:00"),late=set("21:00");assert.equal(comparePurchaseSlots([early,late]).strictDays,1);
 assert.equal(comparePurchaseSlots([early,{...late,completedAt:time("21:01")}]).delayedDays,1);
 assert.equal(comparePurchaseSlots([early,{...late,baseModelVersion:null}]).pairedDays,0);
 assert.equal(purchaseCaptureState(date,"1700",[],[],Date.parse(time("18:00"))).state,"missing_evidence");
});
test("strict slot probability comparison excludes late, stale, changed version and different fixtures",()=>{
 const row=slot=>({officialMatchId:"1",salesDate:date,scheduledAt:time(slot),capturedAt:time(slot),kickoffAt:time("23:00"),baseModelVersion:"v1",calibrationVersion:"none",modelInput:{decisionAt:time(slot),official:{officialMatchId:"1",salesDate:date,kickoffAt:time("23:00"),fetchedAt:time(slot),hadOdds:[2,3,4]}},modelHad:[60,25,15].map((probability,i)=>({score:MARKET_META.had.labels[i],probability})),fullScore:"1:0",halfScore:"0:0"});
 const early=row("17:00"),late=row("21:00");assert.equal(comparePredictionSlots([early,late]).commonFixtures,1);
 for(const changed of [{capturedAt:time("21:01")},{capturedAt:time("20:30")},{baseModelVersion:"v2"},{officialMatchId:"2"}])assert.equal(comparePredictionSlots([early,{...late,...changed}]).commonFixtures,0);
});
test("capture lock and append-only journal distinguish concurrent skip, failure and no-ticket",async()=>{
 const root=await mkdtemp(join(tmpdir(),"football-capture-guard-"));
 try{
  let started,release;const running=new Promise(r=>started=r),hold=new Promise(r=>release=r);
  const first=runCapture({kind:"purchase",slot:"1700"},async()=>{started();await hold;return {status:"saved",outcome:"no_ticket",snapshotId:"real-test"};},{root});
  await running;const second=await runCapture({kind:"purchase",slot:"1700"},()=>{throw Error("must not run");},{root});
  assert.equal(second.reason,"capture-already-running");release();await first;
  await assert.rejects(runCapture({kind:"purchase",slot:"1700"},()=>{throw Object.assign(Error("source failed"),{code:"OFFICIAL_MANIFEST_UNAVAILABLE",sourceState:{manifestState:"unknown"}});},{root}),/source failed/);
  const files=await readdir(join(root,"data/capture-attempts")),events=await Promise.all(files.map(n=>readFile(join(root,"data/capture-attempts",n),"utf8").then(JSON.parse)));
  assert.equal(events.length,3);assert.equal(new Set(events.map(e=>e.attemptId)).size,3);
  const failure=events.find(e=>e.status==="failed");assert.equal(failure.sourceCode,"OFFICIAL_MANIFEST_UNAVAILABLE");assert.equal(failure.sourceState.manifestState,"unknown");assert.equal(failure.officialManifest,null);
  const summary=compactCaptureAttempts(events)[0];assert.equal(summary.attemptCount,3);assert.equal(summary.outcomes.failed,1);assert.equal(summary.successfulOutcome,"no_ticket");
  assert.equal(summary.sourceCode,"OFFICIAL_MANIFEST_UNAVAILABLE");assert.equal(summary.sourceState.manifestState,"unknown");
  assert.equal((await readdir(join(root,"work/capture-locks"))).length,0);
 }finally{await rm(root,{recursive:true,force:true});}
});
