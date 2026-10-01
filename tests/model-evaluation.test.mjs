import test from "node:test";
import assert from "node:assert/strict";
import {buildModelEvaluation,comparePredictionSlots} from "../app/model-evaluation.js";
import {selectDecisionObservations,selectOfficialDecisionRows} from "../app/snapshot-decision-policy.js";
import {completeDistribution,projectOfficialScores,pairedInterval,scoreProbability,EXACT_SCORE_LABELS} from "../app/probability-evaluation.js";
import {MARKET_META} from "../app/purchase-plan-engine.js";
import {retainsPurchaseSnapshot} from "../app/purchase-snapshot-retention.js";
import {slotProbabilityObservations,slotProbabilityResultDates,isProbabilitySlotSnapshot} from "../app/slot-probability-observations.js";
const points=(h,d,a)=>[h,d,a].map((probability,i)=>({score:["胜","平","负"][i],probability}));
const full=labels=>labels.map(score=>({score,probability:100/labels.length}));
const row=(index,score="1:0")=>{const date=new Date(Date.UTC(2026,8,1+index)).toISOString().slice(0,10),kickoffAt=date+"T20:00:00+08:00",capturedAt=date+"T19:30:00+08:00";return{key:date+"|"+index,salesDate:date,kickoffAt,capturedAt,shadowGeneratedAt:date+"T19:29:00+08:00",officialMatchId:String(index+1),id:"test"+index,league:"测试",modelHad:points(60,25,15),challengerHad:points(55,25,20),scoreDistribution:full(EXACT_SCORE_LABELS),hhadProbabilities:full(["让胜","让平","让负"]),totalGoalProbabilities:full(MARKET_META.total.labels),halfFullProbabilities:full(MARKET_META.halfFull.labels),fullScore:score,halfScore:"1:0",modelInput:{decisionAt:capturedAt,official:{officialMatchId:String(index+1),salesDate:date,kickoffAt,fetchedAt:date+"T19:25:00+08:00",handicap:-1,hadOdds:[2,4,4],hhadOdds:[3,3,3],totalOdds:Array(8).fill(8),scoreOdds:Array(31).fill(31),halfFullOdds:Array(9).fill(9)}}};};
test("fixed decision selects before dedup and requires actual capture",()=>{const early=row(0),late={...early,capturedAt:early.salesDate+"T19:31:00+08:00",predictionId:"late"};assert.equal(selectDecisionObservations([late,early]).rows[0].capturedAt,early.capturedAt);assert.equal(selectDecisionObservations([{...early,capturedAt:"",predictionGeneratedAt:early.capturedAt}]).rows.length,0);assert.equal(selectDecisionObservations([{...early,kickoffAt:early.kickoffAt.replace("+08:00","")}]).rows.length,0);assert.equal(selectOfficialDecisionRows([{date:early.salesDate,scheduledAt:early.capturedAt,capturedAt:late.capturedAt,matches:[early]}]).length,0);});
test("paired official baseline is pure frozen odds and deduplicated fixture",()=>{const r=buildModelEvaluation([row(0),row(1,"0:1"),row(1,"0:1")]);assert.equal(r.sampleSize,2);assert.equal(r.windows.all.champion.sampleSize,2);assert.equal(r.windows.all.market.sampleSize,2);assert.equal(r.windows.all.challengerComparison.sampleSize,2);assert.equal(r.windows.all.markets.scoreOfficial.paired.sampleSize,2);assert.ok(r.windows.all.markets.total.rps!==null);});
test("missing provenance never manufactures baseline or scores incomplete probability",()=>{const a=row(0);delete a.modelInput;const r=buildModelEvaluation([a]);assert.equal(r.sampleSize,1);assert.equal(r.windows.all.pairedSampleSize,0);assert.equal(r.windows.all.market.brier,null);a.scoreDistribution=a.scoreDistribution.slice(0,3);assert.equal(buildModelEvaluation([a]).windows.all.markets.score.sampleSize,0);});
test("pending completeness does not depend on settlement and coverage includes missing fixtures",()=>{const a=row(0),b=row(1),pending={...a,fullScore:"",halfScore:""};const before=buildModelEvaluation([pending],{fixtureUniverse:[a,b]}),after=buildModelEvaluation([a],{fixtureUniverse:[a,b]});assert.equal(before.dataHealth.completeCoverage,.5);assert.equal(before.dataHealth.completeCoverage,after.dataHealth.completeCoverage);assert.equal(before.dataHealth.expectedFixtures,2);assert.equal(before.dataHealth.capturedFixtures,1);});
test("late shadow excludes challenger only, not the valid base",()=>{const a=row(0);a.shadowGeneratedAt=a.salesDate+"T19:31:00+08:00";const r=buildModelEvaluation([a]);assert.equal(r.windows.all.pairedSampleSize,1);assert.equal(r.windows.all.challengerComparison.sampleSize,0);});
test("strong reversal is a noncausal pattern, not a training instruction",()=>{const r=buildModelEvaluation([row(0,"0:2")]);assert.equal(r.errors.items[0].code,"strong_direction_miss");assert.equal(r.errors.items[0].trainable,false);assert.equal(r.promotion.eligible,false);});
test("CRS projection normalizes tolerated rounding and rejects partial grids",()=>{const p=full(EXACT_SCORE_LABELS).map(p=>({...p,probability:p.probability*.996}));assert.ok(Math.abs(projectOfficialScores(p).reduce((s,p)=>s+p,0)-1)<1e-12);assert.equal(projectOfficialScores(p.slice(0,168)),null);assert.equal(completeDistribution([{score:"胜",probability:60}],["胜","平","负"]),null);});
test("ordered total RPS and paired bootstrap are deterministic and sparse-safe",()=>{assert.ok(Math.abs(scoreProbability([.5,.5,0],2,true).rps-.625)<1e-12);assert.equal(pairedInterval([{model:{},market:{}}]).sampleSize,0);const r=Array.from({length:30},(_,i)=>({key:String(i),salesDate:"day"+i%6,model:{brier:.2},market:{brier:.3}}));assert.deepEqual(pairedInterval(r),pairedInterval(r));assert.ok(Math.abs(pairedInterval(r).delta+.1)<1e-12);assert.equal(pairedInterval(r.slice(0,3)).lower,null);});
test("unknown handicap and impossible half score remain unscored",()=>{const a=row(0);a.modelInput.official.handicap=null;a.halfScore="5:0";const r=buildModelEvaluation([a]);assert.equal(r.windows.all.markets.hhad.sampleSize,0);assert.equal(r.windows.all.markets.halfFull.sampleSize,0);});

const slotRow=slot=>{
 const base=row(0),date=base.salesDate,capturedAt=`${date}T${slot}:00+08:00`,kickoffAt=`${date}T23:00:00+08:00`;
 return {...base,scheduledTime:slot,baseModelVersion:"same-model",calibrationVersion:"same-calibration",capturedAt,kickoffAt,
  modelInput:{...base.modelInput,decisionAt:capturedAt,official:{...base.modelInput.official,kickoffAt,fetchedAt:capturedAt}}};
};
test("17/21 probability comparison pairs the same contract and isolates missing half results",()=>{
 const early=slotRow("17:00"),late=slotRow("21:00");late.modelHad=points(70,20,10);late.halfScore="";late.modelInput.official.handicap=-2;
 const before=JSON.stringify([early,late]),report=comparePredictionSlots([early,late]);
 const markets=report.strata[0].markets;
 assert.equal(markets.had.sampleSize,1);assert.ok(Math.abs(markets.had.brierInterval.delta+.105)<1e-10);
 assert.equal(markets.total.sampleSize,1);assert.equal(markets.hhad.sampleSize,0);assert.equal(markets.halfFull.sampleSize,0);
 assert.ok(report.excluded.some(row=>row.market==="hhad"&&row.reason==="market-contract-mismatch"));
 assert.equal(report.isCashComparison,false);assert.equal(JSON.stringify([early,late]),before);
});
test("same kickoff instant is comparable but recovery flags cannot become strict probability samples",()=>{
 const early=slotRow("17:00"),late=slotRow("21:00");late.kickoffAt=new Date(late.kickoffAt).toISOString();late.modelInput.official.kickoffAt=late.kickoffAt;
 assert.equal(comparePredictionSlots([early,late]).commonFixtures,1);
 late.includedInStrictEvaluation=false;
 const report=comparePredictionSlots([early,late]);assert.equal(report.commonFixtures,0);
 assert.ok(report.excluded.some(row=>row.reason==="unverified-completion"));
});

test("explicit verified no-bet survives API/index retention, unknown empty plans do not",()=>{
 const record={recordType:"purchase-plan-snapshot",immutable:true,snapshotId:"no-bet",planSet:{version:15,plans:[],decisionSummary:{evaluated:true,noBet:true,coverage:{missingEligibleCount:0}}}};
 assert.equal(retainsPurchaseSnapshot(record),true);
 assert.equal(retainsPurchaseSnapshot({...record,immutable:false}),false);
 for(const decisionSummary of [{evaluated:false,noBet:true,coverage:{missingEligibleCount:0}},{evaluated:true,noBet:true,coverage:{missingEligibleCount:1}},{evaluated:true,noBet:false,coverage:{missingEligibleCount:0}}])
  assert.equal(retainsPurchaseSnapshot({...record,planSet:{...record.planSet,decisionSummary}}),false);
 assert.equal(retainsPurchaseSnapshot({...record,planSet:{version:1,plans:[{legacy:true}]}}),true);
});

test("probability pairing includes all frozen forecasts, independent of tickets and no-bet",()=>{
 const snapshots=["17:00","21:00"].map(slot=>{
  const base=slotRow(slot);
  return {snapshotId:slot,date:base.salesDate,scheduledAt:base.capturedAt,capturedAt:base.capturedAt,planSet:{plans:[],decisionSummary:{noBet:true}},matches:[1,2,3].map(id=>({
   ...base,officialMatchId:String(id),hadProbabilities:base.modelHad,fullScoreDistribution:base.scoreDistribution,
   modelInput:{...base.modelInput,official:{...base.modelInput.official,officialMatchId:String(id)}}
  }))};
 });
 const results=[1,2,3].map(id=>({matchId:String(id),date:snapshots[0].date,fullScore:"1:0",halfScore:"1:0"}));
 const observations=slotProbabilityObservations(snapshots,results), report=comparePredictionSlots(observations);
 assert.equal(report.commonFixtures,3);assert.equal(report.strata[0].markets.had.sampleSize,3);
 assert.equal(comparePredictionSlots([...observations,...observations]).commonFixtures,3);
 const now=Date.parse(snapshots[0].date+"T23:59:59+08:00")+4*3600000;
 assert.equal(slotProbabilityResultDates(snapshots,[],now).length,1);
 assert.deepEqual(slotProbabilityResultDates(snapshots,results,now),[]);
 assert.equal(slotProbabilityResultDates(snapshots,results.map(({halfScore,...rest})=>rest),now).length,1);
});

test("17/21 slot selection uses Shanghai instants, not ISO text offsets",()=>{
 for(const scheduledAt of ["2026-10-02T17:00:00+08:00","2026-10-02T09:00:00Z","2026-10-02T13:00:00Z"])
  assert.equal(isProbabilitySlotSnapshot({scheduledAt}),true);
 for(const scheduledAt of ["2026-10-02T17:30:00+08:00","invalid",""])
  assert.equal(isProbabilitySlotSnapshot({scheduledAt}),false);
});

test("UTC purchase forecasts reach same-fixture pairing, not just the slot selector",()=>{
 const snapshots=["17:00","21:00"].map(slot=>{
  const base=slotRow(slot);
  return {snapshotId:slot,date:base.salesDate,scheduledAt:new Date(base.capturedAt).toISOString(),capturedAt:base.capturedAt,
   matches:[{...base,hadProbabilities:base.modelHad,fullScoreDistribution:base.scoreDistribution}]};
 });
 const observations=slotProbabilityObservations(snapshots,[{matchId:"1",date:snapshots[0].date,fullScore:"1:0",halfScore:"1:0"}]);
 assert.deepEqual(observations.map(row=>row.scheduledTime),["17:00","21:00"]);
 assert.equal(comparePredictionSlots(observations).commonFixtures,1);
 assert.equal(comparePredictionSlots(observations.map(({scheduledTime,...row})=>row)).commonFixtures,1);
 const delayed=observations.map(row=>({...row,includedInStrictEvaluation:false}));
 assert.equal(comparePredictionSlots(delayed).commonFixtures,0);
 assert.equal(comparePredictionSlots(delayed).excluded.filter(row=>row.reason==="unverified-completion").length,2);
});

test("overnight official results join by actual ID, display numbers and conflicts are excluded",()=>{
 const base=slotRow("17:00"),snapshot={snapshotId:"overnight",date:base.salesDate,scheduledAt:base.capturedAt,capturedAt:base.capturedAt,matches:[{...base,kickoffAt:"2026-09-02T02:00:00+08:00",hadProbabilities:base.modelHad}]};
 const joined=slotProbabilityObservations([snapshot],[{matchId:base.officialMatchId,date:"2026-09-02",fullScore:"2:0"}]);
 assert.equal(joined[0].fullScore,"2:0");
 assert.equal(slotProbabilityObservations([snapshot],[{id:base.officialMatchId,date:base.salesDate,fullScore:"2:0"}])[0].fullScore,"");
 assert.equal(slotProbabilityObservations([snapshot],[{matchId:base.officialMatchId,date:base.salesDate,fullScore:"1:0"},{matchId:base.officialMatchId,date:"2026-09-02",fullScore:"2:0"}])[0].resultConflict,true);
});

test("same-slot comparison rejects missing frozen official provenance and late completion",()=>{
 const early=slotRow("17:00"),late=slotRow("21:00");
 const absent={...late,modelInput:undefined};
 assert.equal(comparePredictionSlots([early,absent]).commonFixtures,0);
 assert.ok(comparePredictionSlots([early,absent]).excluded.some(row=>row.reason==="missing-frozen-official-input"));
 assert.equal(comparePredictionSlots([early,{...late,completedAt:late.salesDate+"T21:00:01+08:00"}]).commonFixtures,0);
});
