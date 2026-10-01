import test from "node:test";
import assert from "node:assert/strict";
import {calculatePortfolioScenarioRisk as risk,deriveScenarioMarketOutcome as outcome,validateFixtureScoreDistribution as validate,EXACT_SCORE_LABELS} from "../app/portfolio-scenario-risk.js";
import {settleTicket,calculateTicketEconomics,TICKET_SETTLEMENT_VERSION} from "../app/ticket-economics.js";

// Ready for tests/portfolio-scenario-risk.test.mjs in the actual project.
// Every monetary/probability fixture below is synthetic, never real risk data.
const date="2026-10-01", assessmentAt=`${date}T21:00:00+08:00`, basisPredictionId="synthetic-basis-21";
const key=id=>`${date}|${id}`;
const grid=(weights={"1:0":60,"0:0":20,"0:1":20})=>EXACT_SCORE_LABELS.map(score=>({score,probability:weights[score]||0}));
const forecast=(id,weights,extra={})=>({officialMatchId:id,salesDate:date,predictionId:basisPredictionId,predictionGeneratedAt:assessmentAt,fullScoreDistribution:grid(weights),...extra});
const leg=(id,market="had",picks=[{pick:"胜",odd:3,probability:99}],extra={})=>({officialMatchId:id,salesDate:date,market,picks,...extra});
const plan=(id,items,extra={})=>({id,status:"pending",stake:items.reduce((n,item)=>n*(item.scores||item.picks||[item]).length,1)*2,items,...extra});
const run=(input={})=>risk({plans:[],fixtureForecasts:[],basisPredictionId,assessmentAt,currentBatchId:"synthetic-21",...input});
const approx=(actual,expected,tolerance=1e-10)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);
function deepFreeze(value) {if(value&&typeof value==="object") {Object.freeze(value);for(const child of Object.values(value)) deepFreeze(child);}return value;}

test("synthetic same-fixture score, HAD, HHAD and total are one joint event",()=>{
  const plans=[plan("score",[leg("A","score",[{pick:"1:0",odd:2}])]),plan("had",[leg("A","had",[{pick:"胜",odd:2}])]),plan("hhad",[leg("A","hhad",[{pick:"让平",odd:2}],{handicap:"-1"})]),plan("total",[leg("A","total",[{pick:"1球",odd:2}])])];
  const result=run({plans,fixtureForecasts:[forecast("A")]});
  assert.equal(result.status,"ready");assert.equal(result.method,"exact-shared-fixture-states");assert.equal(result.scenarioCount,3);assert.equal(result.totalStake,8);
  approx(result.allWinningTicketProbability,.6);approx(result.anyWinningTicketProbability,.8);approx(result.zeroReturnProbability,.2);approx(result.lossProbability,.4);approx(result.expectedProfit,2.4);
  assert.equal(result.assumptions.crossFixture,"assumed-independent");assert.equal(result.assumptions.withinFixture,"one-score-event-shared-by-all-tickets");assert.equal(result.settlementVersion,TICKET_SETTLEMENT_VERSION);
});
test("synthetic mutually exclusive tickets cannot both win",()=>{
  const result=run({plans:[plan("win",[leg("A","had",[{pick:"胜",odd:2}])]),plan("draw",[leg("A","had",[{pick:"平",odd:2}])])],fixtureForecasts:[forecast("A",{"1:0":50,"0:0":50})]});
  assert.equal(result.allWinningTicketProbability,0);assert.equal(result.anyWinningTicketProbability,1);assert.equal(result.lossProbability,0);assert.equal(result.expectedProfit,0);
});
test("synthetic shared A in tickets AB and AC preserves dependence across tickets",()=>{
  const plans=[plan("AB",[leg("A"),leg("B")]),plan("AC",[leg("A"),leg("C")])], forecasts=["A","B","C"].map(id=>forecast(id,{"1:0":50,"0:0":50}));
  const result=run({plans,fixtureForecasts:forecasts});
  approx(result.anyWinningTicketProbability,.375);approx(result.allWinningTicketProbability,.125);approx(result.zeroReturnProbability,.625);approx(result.expectedReturn,9);
  const repricedEV=plans.reduce((sum,ticket)=>sum+calculateTicketEconomics(ticket.items.map(item=>({...item,picks:item.picks.map(p=>({...p,probability:50}))}))).expectedReturn,0);
  approx(result.expectedReturn,repricedEV);assert.equal(result.crossFixtureCorrelationEstimated,false);
});
test("synthetic exact scores map to official other buckets and 7+ goals",()=>{
  assert.equal(outcome({homeGoals:7,awayGoals:0},"score"),"胜其他");assert.equal(outcome({homeGoals:4,awayGoals:4},"score"),"平其他");assert.equal(outcome({homeGoals:0,awayGoals:7},"score"),"负其他");assert.equal(outcome({homeGoals:4,awayGoals:4},"total"),"7+球");
  assert.equal(outcome({homeGoals:1,awayGoals:0},"hhad","-1"),"让平");assert.equal(outcome({homeGoals:0,awayGoals:0},"hhad","+1"),"让胜");
});
test("separate synthetic real purchase batches retain identical tickets and exact shared hits",()=>{
  const early=plan("same-type",[leg("A")],{priorBatchId:"synthetic-17"}), later=plan("same-type",[leg("A")]);
  const result=run({plans:[later],priorPlans:[early],fixtureForecasts:[forecast("A",{"1:0":50,"0:0":50})]});
  assert.equal(result.ticketCount,2);assert.equal(result.totalStake,4);assert.equal(result.scope,"day-with-verified-prior");assert.equal(result.duplicateEvidenceCount,0);
  approx(result.anyWinningTicketProbability,.5);approx(result.allWinningTicketProbability,.5);approx(result.expectedReturn,6);
});
test("repeated evidence for one synthetic purchase identity is counted once",()=>{
  const early=plan("same-type",[leg("A")],{priorBatchId:"synthetic-17"});
  const result=run({priorPlans:[early,structuredClone(early)],fixtureForecasts:[forecast("A")]});
  assert.equal(result.ticketCount,1);assert.equal(result.totalStake,2);assert.equal(result.duplicateEvidenceCount,1);
});
test("same synthetic identity with different frozen prices is unavailable",()=>{
  const early=plan("same-type",[leg("A")],{priorBatchId:"synthetic-17"}), conflict=structuredClone(early);conflict.items[0].picks[0].odd=4;
  assert.equal(run({priorPlans:[early,conflict],fixtureForecasts:[forecast("A")]}).reason,"ticket_evidence_conflict");
});
test("early synthetic prices and handicaps stay frozen under the shared late assessment",()=>{
  const early=plan("hhad",[leg("A","hhad",[{pick:"让平",odd:3}],{handicap:-1})],{priorBatchId:"synthetic-17"}), later=plan("hhad",[leg("A","hhad",[{pick:"让胜",odd:4}],{handicap:1})]);
  const result=run({plans:[later],priorPlans:[early],fixtureForecasts:[forecast("A",{"1:0":100})]});
  assert.equal(result.expectedReturn,14);assert.equal(result.expectedProfit,10);assert.equal(result.allWinningTicketProbability,1);
});
test("synthetic scenario monetary rounding matches the real settlement implementation",()=>{
  for(const [firstOdd,expected] of [[1.61,4.02],[1.63,4.08],[1.65,5.78]]) {
    const secondOdd=firstOdd===1.65?1.75:1.25, ticket=plan("rounded",[leg("A","had",[{pick:"胜",odd:firstOdd}]),leg("B","had",[{pick:"胜",odd:secondOdd}])]);
    const result=run({plans:[ticket],fixtureForecasts:[forecast("A",{"1:0":100}),forecast("B",{"1:0":100})]});
    assert.equal(result.expectedReturn,expected);assert.equal(result.expectedReturn,settleTicket(ticket.items.map(item=>({...item,actual:"胜",settlementState:"settled"}))).returned);
  }
});
test("synthetic unit caps follow original ticket leg count",()=>{
  const items=[leg("A","had",[{pick:"胜",odd:250000}]),..."BCD".split("").map(id=>leg(id,"had",[{pick:"胜"}]))];
  const result=run({plans:[plan("capped",items)],knownVoidFixtureKeys:"BCD".split("").map(key),fixtureForecasts:[forecast("A",{"1:0":100})]});
  assert.equal(result.expectedReturn,500000);
});
test("synthetic partial void preserves each purchased selection as a separate unit",()=>{
  const voidLeg=leg("V","total",[{pick:"2球"},{pick:"3球"}]), live=leg("A","had",[{pick:"胜",odd:3}]);
  const result=run({plans:[plan("partial-void",[voidLeg,live])],knownVoidFixtureKeys:[key("V")],fixtureForecasts:[forecast("A",{"1:0":100})]});
  assert.equal(result.totalStake,4);assert.equal(result.expectedReturn,12);assert.equal(result.expectedProfit,8);assert.equal(result.anyWinningTicketProbability,1);
});
test("synthetic partial void rounds each unit before summing",()=>{
  const items=[leg("V","total",[{pick:"2球"},{pick:"3球"}]),leg("A","had",[{pick:"胜",odd:1.65}]),leg("B","had",[{pick:"胜",odd:1.75}])];
  const result=run({plans:[plan("rounded-void",items)],knownVoidFixtureKeys:[key("V")],fixtureForecasts:[forecast("A",{"1:0":100}),forecast("B",{"1:0":100})]});
  assert.equal(result.expectedReturn,11.56);
});
test("synthetic all-void refunds equal stake and are not scored as wins",()=>{
  const items=[leg("V1","total",[{pick:"2球"},{pick:"3球"}]),leg("V2","had",[{pick:"胜"},{pick:"平"}])];
  const result=run({plans:[plan("refund",items)],knownVoidFixtureKeys:[key("V1"),key("V2")]});
  assert.equal(result.expectedReturn,8);assert.equal(result.totalStake,8);assert.equal(result.expectedProfit,0);assert.equal(result.lossProbability,0);assert.equal(result.zeroReturnProbability,0);assert.equal(result.anyWinningTicketProbability,0);assert.deepEqual(result.netProfitQuantiles,{p05:0,p50:0,p95:0});
});
test("synthetic frozen pick probabilities never substitute for assessment score probabilities",()=>{
  const result=run({plans:[plan("different-frozen-probability",[leg("A")])],fixtureForecasts:[forecast("A",{"1:0":25,"0:0":75})]});
  assert.equal(result.expectedReturn,1.5);assert.equal(result.expectedProfit,-.5);
});
test("synthetic prior fixtures missing from the chosen basis make the whole day unavailable",()=>{
  const early=plan("early",[leg("OLD")],{priorBatchId:"synthetic-17"});
  const result=run({plans:[plan("late",[leg("NEW")])],priorPlans:[early],fixtureForecasts:[forecast("NEW")]});
  assert.equal(result.status,"unavailable");assert.equal(result.reason,"assessment_basis_incomplete");assert.deepEqual(result.details.missingFixtures,[key("OLD")]);assert.equal(result.lossProbability,null);
});
test("mixed synthetic assessment versions are unavailable",()=>{
  const result=run({plans:[plan("one",[leg("A")])],fixtureForecasts:[forecast("A",undefined,{predictionId:"synthetic-basis-17"})]});
  assert.equal(result.reason,"assessment_basis_conflict");
});
test("conflicting same-basis synthetic fixture distributions are unavailable",()=>{
  const result=run({plans:[plan("one",[leg("A")])],fixtureForecasts:[forecast("A"),forecast("A",{"1:0":50,"0:0":25,"0:1":25})]});
  assert.equal(result.reason,"fixture_distribution_conflict");
});
test("repeated identical synthetic fixture forecasts are harmless evidence duplicates",()=>{
  const f=forecast("A"), result=run({plans:[plan("one",[leg("A")])],fixtureForecasts:[f,structuredClone(f)]});assert.equal(result.status,"ready");assert.equal(result.fixtureCount,1);
});
test("future synthetic forecasts cannot enter an earlier as-of assessment",()=>{
  const result=run({plans:[plan("one",[leg("A")])],fixtureForecasts:[forecast("A",undefined,{predictionGeneratedAt:`${date}T21:01:00+08:00`})]});assert.equal(result.reason,"assessment_basis_from_future");
});
test("all 169 synthetic points are required; top-four reconstruction is refused",()=>{
  const f=forecast("A");f.fullScoreDistribution=f.fullScoreDistribution.slice(0,4);assert.equal(run({plans:[plan("one",[leg("A")])],fixtureForecasts:[f]}).reason,"score_distribution_incomplete");
});
test("duplicate, negative, NaN and over-mass synthetic score distributions fail validation",()=>{
  for(const alter of [points=>{points[1].score=points[0].score;},points=>{points[0].probability=-1;},points=>{points[0].probability=NaN;},points=>{points.find(p=>p.score==="1:0").probability+=1;}]) {
    const points=grid();alter(points);assert.throws(()=>validate(points));
  }
});
test("small declared synthetic mass drift is normalized and disclosed",()=>{
  const f=forecast("A",{"1:0":49.8,"0:0":49.8}), result=run({plans:[plan("one",[leg("A")])],fixtureForecasts:[f]});
  assert.equal(result.status,"ready");approx(result.fixtureBasis[0].sourceTotalPercent,99.6);assert.equal(result.fixtureBasis[0].normalizationApplied,true);approx(result.anyWinningTicketProbability,.5);
});
test("invalid or missing synthetic HHAD lines and half-full markets are unavailable",()=>{
  for(const handicap of [undefined,null,"",.5,"not-a-line",true,[],"0x10",9007199254740992]) {const result=run({plans:[plan("bad",[leg("A","hhad",[{pick:"让胜",odd:3}],{handicap})])],fixtureForecasts:[forecast("A")]});assert.equal(result.reason,"handicap_invalid");}
  assert.equal(run({plans:[plan("half",[leg("A","halfFull",[{pick:"胜胜",odd:3}])])],fixtureForecasts:[forecast("A")]}).reason,"half_full_unavailable");
});
test("unverified synthetic prior identity and mismatched frozen stake fail closed",()=>{
  assert.equal(run({priorPlans:[plan("early",[leg("A")])],fixtureForecasts:[forecast("A")]}).reason,"ticket_identity_missing");
  assert.equal(run({plans:[plan("wrong",[leg("A")],{stake:4})],fixtureForecasts:[forecast("A")]}).reason,"frozen_stake_mismatch");
});
test("synthetic official fixture ID cannot silently change sales date across tickets",()=>{
  const result=run({plans:[plan("one",[leg("A")]),plan("two",[leg("A","had",[{pick:"胜",odd:3}],{salesDate:"2026-10-02"})])],fixtureForecasts:[forecast("A")]});assert.equal(result.reason,"fixture_identity_conflict");
});
test("sampling fallback is fixed-seed deterministic with invariant input order",()=>{
  const plans=[plan("AB",[leg("A"),leg("B")]),plan("AC",[leg("A"),leg("C")])], forecasts=["A","B","C"].map(id=>forecast(id,{"1:0":50,"0:0":50})), options={plans,fixtureForecasts:forecasts,maxExactStates:1,sampleCount:2000,seed:"synthetic-fixed-seed"};
  const one=run(options), two=run(options), permuted=run({...options,plans:plans.toReversed(),fixtureForecasts:forecasts.toReversed().map(f=>({...f,fullScoreDistribution:f.fullScoreDistribution.toReversed()}))});
  assert.equal(one.method,"seeded-score-sampling");assert.equal(one.sampleCount,2000);assert.equal(one.seed,"synthetic-fixed-seed");assert.deepEqual(one,two);assert.deepEqual(one,permuted);approx(one.anyWinningTicketProbability,.375,.04);assert.equal(one.isConfidenceInterval,false);
});
test("synthetic exact mode refuses an explicit enumeration bound instead of silently sampling",()=>{
  const result=run({plans:[plan("one",[leg("A")])],fixtureForecasts:[forecast("A")],method:"exact",maxExactStates:1});assert.equal(result.reason,"exact_state_bound_exceeded");
});
test("synthetic forced sampling is available even for a small exact distribution",()=>{
  const result=run({plans:[plan("one",[leg("A")])],fixtureForecasts:[forecast("A")],method:"sample",sampleCount:100});assert.equal(result.method,"seeded-score-sampling");assert.equal(result.scenarioCount,100);
});
test("synthetic weighted quantiles and worst-five-percent mean use signed net profit",()=>{
  const result=run({plans:[plan("one",[leg("A")])],fixtureForecasts:[forecast("A",{"1:0":90,"0:0":10})]});
  assert.deepEqual(result.netProfitQuantiles,{p05:-2,p50:4,p95:4});assert.equal(result.worstFivePercentMeanProfit,-2);assert.equal(result.minimumScenarioProfit,-2);assert.equal(result.maximumScenarioProfit,4);
});
test("synthetic refunds in one ticket do not inflate at-least-one-winning-ticket probability",()=>{
  const result=run({plans:[plan("refund",[leg("V","had",[{pick:"胜"}])]),plan("live",[leg("A")])],knownVoidFixtureKeys:[key("V")],fixtureForecasts:[forecast("A",{"1:0":50,"0:0":50})]});
  approx(result.anyWinningTicketProbability,.5);assert.equal(result.allWinningTicketProbability,0);assert.equal(result.zeroReturnProbability,0);approx(result.lossProbability,.5);
});
test("synthetic input tickets and forecasts remain immutable",()=>{
  const input=deepFreeze({plans:[plan("one",[leg("A")])],fixtureForecasts:[forecast("A")]});const before=JSON.stringify(input);assert.equal(run(input).status,"ready");assert.equal(JSON.stringify(input),before);assert.equal(input.plans[0].items[0].actual,undefined);
});
test("empty synthetic portfolio is distinct from unavailable data or losing tickets",()=>{
  const result=run();assert.equal(result.status,"empty");assert.equal(result.totalStake,0);assert.equal(result.lossProbability,null);
});
test("bounds and absent synthetic assessment basis are explicit errors",()=>{
  assert.equal(run({sampleCount:0}).reason,"bounds_invalid");assert.equal(run({basisPredictionId:""}).reason,"assessment_basis_missing");assert.equal(run({assessmentAt:"invalid"}).reason,"assessment_time_invalid");
});
test("malformed synthetic ticket evidence cannot silently disappear from the scope",()=>{
  assert.equal(run({plans:[null]}).reason,"ticket_invalid");assert.equal(run({priorPlans:["not-a-ticket"]}).reason,"ticket_invalid");
});
test("required synthetic fixture prediction time cannot be missing or empty",()=>{
  for(const predictionGeneratedAt of [undefined,null,""]) {
    const result=run({plans:[plan("one",[leg("A")])],fixtureForecasts:[forecast("A",undefined,{predictionGeneratedAt})]});
    assert.equal(result.status,"unavailable");assert.match(result.reason,/^assessment_basis_time_(?:missing|invalid)$/);assert.equal(result.lossProbability,null);
  }
});
test("synthetic prediction timestamps must be valid ISO times with an explicit timezone",()=>{
  for(const predictionGeneratedAt of ["invalid","2026-10-01T20:59:59","2026-02-30T12:00:00+08:00",Date.parse(assessmentAt)]) {
    const result=run({plans:[plan("one",[leg("A")])],fixtureForecasts:[forecast("A",undefined,{predictionGeneratedAt})]});
    assert.equal(result.status,"unavailable");assert.equal(result.reason,"assessment_basis_time_invalid");
  }
});
test("synthetic assessment times cannot silently rely on host timezone or calendar rollover",()=>{
  for(const badTime of ["2026-10-01T21:00:00","2026-02-30T21:00:00+08:00",Date.parse(assessmentAt)]) {
    const result=run({assessmentAt:badTime});assert.equal(result.status,"unavailable");assert.equal(result.reason,"assessment_time_invalid");
  }
});
test("strict synthetic UTC and offset prediction times may precede or equal assessment time",()=>{
  for(const predictionGeneratedAt of ["2026-10-01T12:59:59.123Z","2026-10-01T13:00:00Z",assessmentAt]) {
    const result=run({plans:[plan("one",[leg("A")])],fixtureForecasts:[forecast("A",undefined,{predictionGeneratedAt})]});assert.equal(result.status,"ready");
  }
});
test("research metadata declares fractional probabilities and no statistical confidence or estimated cross-fixture correlation",()=>{
  const ready={plans:[plan("one",[leg("A")])],fixtureForecasts:[forecast("A")]};
  const results=[run(ready),run({...ready,method:"sample",sampleCount:100}),run(),run({...ready,basisPredictionId:"invalid-version"})];
  for(const result of results) {
    assert.equal(result.probabilityUnit,"fraction");assert.equal(result.isConfidenceInterval,false);assert.equal(result.crossFixtureCorrelationEstimated,false);assert.equal(result.assumptions.crossFixture,"assumed-independent");assert.equal(result.assumptions.withinFixture,"one-score-event-shared-by-all-tickets");assert.equal(result.assumptions.futureVoids,"not-modeled");
    if(result.status==="ready") for(const name of ["lossProbability","zeroReturnProbability","anyWinningTicketProbability","allWinningTicketProbability"]) assert.ok(result[name]>=0&&result[name]<=1);
    else assert.equal(result.lossProbability,null);
  }
});
test("synthetic winning tickets can still yield an aggregate net loss after all unit stakes",()=>{
  const items=["A","B"].map(id=>leg(id,"had",[{pick:"胜",odd:1.1},{pick:"平",odd:1.2}]));
  const result=run({plans:[plan("winner-with-negative-net",items)],fixtureForecasts:[forecast("A",{"1:0":100}),forecast("B",{"1:0":100})]});
  assert.equal(result.anyWinningTicketProbability,1);assert.equal(result.allWinningTicketProbability,1);assert.equal(result.lossProbability,1);assert.equal(result.expectedReturn,2.42);assert.equal(result.expectedProfit,-5.58);assert.equal(result.totalStake,8);
});
test("an unsupported synthetic ticket invalidates the requested combined scope rather than being omitted",()=>{
  const result=run({plans:[plan("valid",[leg("A")]),plan("half",[leg("A","halfFull",[{pick:"胜胜",odd:3}])])],fixtureForecasts:[forecast("A")]});
  assert.equal(result.status,"unavailable");assert.equal(result.reason,"half_full_unavailable");assert.equal(result.expectedProfit,null);
});
