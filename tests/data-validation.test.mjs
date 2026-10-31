import test from 'node:test';
import assert from 'node:assert/strict';
import {buildValidationReport, parseValidationTime} from '../app/data-validation.js';
const now='2026-10-31T10:00:00Z';
const fixture={id:'周六001',officialMatchId:'100',salesDate:'2026-10-31',home:'主队',away:'客队',kickoffAt:'2026-10-31T20:00:00+08:00',odds:[2,3,4],marketStatus:{}};
const report={...fixture,officialMappingStatus:'verified',predictionId:'pred-1',inputSnapshotId:'input-1',baseModelVersion:'model-1',calibrationVersion:'cal-none',predictionGeneratedAt:now,probabilities:{home:50,draw:25,away:25},modelInput:{companies:[{companyId:2,win:2,draw:3,lose:4,fetchedAt:now},{companyId:3,win:2,draw:3,lose:4,fetchedAt:now}]}};
const run=(match=fixture,pred=report,other={})=>buildValidationReport({now,official:{matches:[match],fetchedAt:now},predictions:{reports:[pred]},...other});
const check=(output,id)=>output.fixtures[0].checks.find(row=>row.id===id);
test('failed sources remain unknown, empty successful sources remain empty',()=>{
 assert.equal(buildValidationReport({now}).summary.officialMatches,null);
 assert.equal(buildValidationReport({now,official:{error:'blocked'}}).summary.officialMatches,null);
 assert.equal(buildValidationReport({now,official:{matches:[],fetchedAt:now,poolStatus:Object.fromEntries(['HAD','HHAD','CRS','TTG','HAFU'].map(pool=>[pool,{status:'success'}]))}}).summary.officialMatches,0);
});
test('official times require explicit timezone except documented local quote markers',()=>{
 assert.equal(parseValidationTime('2026-10-31 18:00:00'),null);
 assert.equal(parseValidationTime('2026-10-31 18:00:00',true),Date.parse(now));
 assert.equal(parseValidationTime('2026-10-31'),null);
 assert.throws(()=>buildValidationReport({now:'bad'}));
});
test('unique full identity maps and records provenance without implying stored snapshot',()=>{
 const result=run();assert.equal(result.summary.matchedPredictions,1);assert.equal(check(result,'mapping').status,'pass');assert.match(check(result,'provenance').detail,/不证明已持久化/);
});
test('same display number across sales dates cannot join',()=>{
 const result=run(fixture,{...report,salesDate:'2026-10-30'});assert.equal(result.summary.matchedPredictions,0);assert.equal(result.summary.unmatchedPredictions,1);
});
test('reversed teams and differing kickoff are rejected',()=>{
 for(const patch of [{home:'客队',away:'主队'},{kickoffAt:'2026-10-31T21:00:00+08:00'},{homeTeamId:'wrong'}]){
 const result=run({...fixture,homeTeamId:'correct'},{...report,...patch});assert.equal(result.summary.matchedPredictions,0);assert.equal(check(result,'mapping').status,'fail');
 }
});
test('duplicate official and prediction identities reject automatic selection',()=>{
 assert.equal(run(fixture,report,{official:{matches:[fixture,fixture],fetchedAt:now}}).summary.matchedPredictions,0);
 assert.equal(run(fixture,report,{predictions:{reports:[report,report]}}).summary.matchedPredictions,0);
});
test('research and mock records cannot count as formal coverage',()=>{
 assert.equal(run(fixture,{...report,isMock:true}).summary.matchedPredictions,0);
 assert.equal(run(fixture,report,{predictions:{reports:[report],mode:'research-only'}}).summary.matchedPredictions,0);
});
test('stale and future reads detected separately from actual quote time',()=>{
 const stale=run(fixture,{...report,modelInput:{companies:[{companyId:2,win:2,draw:3,lose:4,fetchedAt:'2026-10-31T09:00:00Z'}]}});
 assert.equal(check(stale,'external-read-time').status,'warn');assert.equal(check(stale,'external-quote-time').status,'unknown');
 const future=run(fixture,report,{official:{matches:[fixture],fetchedAt:'2026-10-31T11:00:00Z'}});
 assert.equal(future.checks.find(row=>row.id==='official-read-time').status,'fail');
});
test('missing evidence and undeclared weight never treated as verified zero',()=>{
 const result=run();assert.equal(check(result,'lineup').status,'unknown');assert.equal(check(result,'intelligence-weight').status,'unknown');
 assert.equal(check(run(fixture,{...report,appliedIntelligenceWeight:0}),'intelligence-weight').status,'pass');
});
test('evidence metadata requires source and 48 hour timestamp and is not factual proof',()=>{
 const evidence=records=>run(fixture,{...report,intelligenceEvidence:{records}});
 assert.equal(check(evidence([{type:'lineup',sourceUrl:'https://example.com',observedAt:now}]),'lineup').status,'warn');
 assert.equal(check(evidence([{type:'lineup',sourceUrl:'https://example.com',observedAt:'2026-10-28T10:00:00Z'}]),'lineup').status,'unknown');
 assert.equal(check(evidence([{type:'lineup',observedAt:now}]),'lineup').status,'unknown');
});
test('invalid odds and probabilities never pass',()=>{
 assert.equal(check(run({...fixture,odds:[2,0,4]}),'official-odds').status,'warn');
 assert.equal(check(run(fixture,{...report,probabilities:{home:80,draw:40,away:10}}),'probabilities').status,'fail');
});
test('history keeps source cutoff, separate metric denominators, and unknown calibration',()=>{
 const output=run(fixture,report,{audit:{generatedAt:now,audit:{generatedAt:'2026-09-12T09:00:00Z',inventory:{strictDecisionRows:33,fallbackDecisionRows:22},overall:{hadTop1:{eligible:33,rate:72.7},totalTop1:{eligible:26,rate:23.1},marketComparable:26}}}});
 assert.equal(output.history.generatedAt,'2026-09-12T09:00:00Z');assert.equal(output.history.metrics[0].eligible,33);assert.equal(output.history.metrics[2].eligible,26);assert.equal(output.history.calibration.forecastSampleSize,null);
});
test('post-kickoff or reversed prediction timestamps cannot pass temporal validation',()=>{
 const output=run(fixture,{...report,predictionGeneratedAt:'2026-10-31T12:01:00Z',sourceFetchedAt:now});
 assert.equal(check(output,'prediction-timing').status,'fail');
 assert.equal(check(run(fixture,{...report,sourceFetchedAt:'2026-10-31T10:02:00Z'}),'prediction-timing').status,'fail');
});

test('empty results require exact successful named pools to establish a true zero',()=>{
 const pools=Object.fromEntries(['HAD','HHAD','CRS','TTG','HAFU'].map(pool=>[pool,{status:'success'}]));
 for(const poolStatus of [undefined, {...pools,HAD:{status:'failed'}}, {A:{status:'success'},B:{status:'success'},C:{status:'success'},D:{status:'success'},E:{status:'success'}}]) {
  const output=buildValidationReport({now,official:{matches:[],fetchedAt:now,poolStatus},predictions:{reports:[]}});
  assert.equal(output.summary.officialMatches,null);assert.equal(output.summary.matchedPredictions,null);assert.equal(output.checks.find(row=>row.id==='official-source').status,'unknown');assert.notEqual(output.checks.find(row=>row.id==='official-pools').status,'pass');
 }
 const missing={...pools};delete missing.HAFU;
 assert.equal(buildValidationReport({now,official:{matches:[],poolStatus:missing}}).summary.officialMatches,null);
 const complete=buildValidationReport({now,official:{matches:[],fetchedAt:now,poolStatus:pools}});
 assert.equal(complete.summary.officialMatches,0);assert.equal(complete.checks.find(row=>row.id==='official-pools').status,'pass');
});
