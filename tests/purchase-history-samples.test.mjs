import test from "node:test";
import assert from "node:assert/strict";
import {summarizePurchaseHistorySamples} from "../app/purchase-history-samples.js";
import {summarizePurchasePlanDefinitions} from "../app/purchase-plan-engine.js";
const leg = (id = "a", date = "2026-10-01") => ({officialMatchId:id, salesDate:date});
const row = (overrides = {}) => ({batchIdentity:"real-1700",date:"2026-10-01",scheduledTime:"17:00",decisionPolicy:"policy-v3",baseModelVersion:"model-v1",calibrationVersion:"cal-v1",riskPolicy:{version:"paper-risk-v2",dailyBudget:100,maxFixtureStake:25},plan:{id:"score-single-2",status:"won",stake:2,simulatedReturn:20,items:[leg()]},...overrides});
test("real repeated purchases remain tickets while shared fixture is one sample", () => {
  const rows=[row(),row({batchIdentity:"real-2100",scheduledTime:"21:00"}),row({batchIdentity:"real-2100",plan:{id:"other",status:"lost",stake:2,simulatedReturn:0,items:[leg(),leg("b")]}})];
  const result=summarizePurchaseHistorySamples(rows);
  assert.equal(result.ticketCount,3);assert.equal(result.batchCount,2);
  assert.equal(result.uniqueFixtureCount,2);assert.equal(result.salesDayCount,1);
  assert.equal(result.settledTicketCount,3);assert.equal(result.statisticalIndependenceEstablished,false);
});
test("model, calibration, decision and frozen risk settings are separate cohorts", () => {
  const rows=[row(),row({riskPolicy:{maxFixtureStake:25,dailyBudget:100,version:"paper-risk-v2"}}),row({baseModelVersion:"model-v2"}),row({calibrationVersion:"cal-v2"}),row({decisionPolicy:"policy-v4"}),row({riskPolicy:{version:"paper-risk-v2",dailyBudget:50,maxFixtureStake:25}})];
  const result=summarizePurchaseHistorySamples(rows);
  assert.equal(result.versionGroups.length,5);
  assert.equal(result.versionGroups.find(group=>group.ticketCount===2).baseModelVersion,"model-v1");
});
test("missing historic versions remain unknown instead of being backfilled", () => {
  const result=summarizePurchaseHistorySamples([row(),row({decisionPolicy:undefined,baseModelVersion:undefined,calibrationVersion:undefined,riskPolicy:undefined})]);
  assert.equal(result.versionGroups.length,2);
  const unknown=result.versionGroups.find(group=>group.baseModelVersion===null);
  assert.equal(unknown.decisionPolicy,null);assert.equal(unknown.calibrationVersion,null);assert.equal(unknown.riskPolicy,null);
});
test("pending and all-void refunds do not become settled win-rate samples", () => {
  const result=summarizePurchaseHistorySamples([row(),row({plan:{status:"pending",items:[leg("b")]}}),row({plan:{status:"refunded",stake:2,simulatedReturn:2,items:[leg("c")]}})]);
  assert.equal(result.ticketCount,3);assert.equal(result.uniqueFixtureCount,3);
  assert.equal(result.settledTicketCount,1);assert.equal(result.settledUniqueFixtureCount,1);
  assert.equal(result.refundedTicketCount,1);
});
test("unverified fixture identity is not replaced by a display name or batch date", () => {
  const result=summarizePurchaseHistorySamples([row({plan:{status:"won",items:[{matchId:"周四001",salesDate:"2026-10-01"},{officialMatchId:"a",matchDate:"2026-10-01"}]}})]);
  assert.equal(result.uniqueFixtureCount,0);assert.equal(result.unidentifiedFixtureOccurrences,2);
});
test("conflicting official identity dates do not inflate unique sample count", () => {
  const result=summarizePurchaseHistorySamples([row(),row({date:"2026-10-02",plan:{status:"won",items:[leg("a","2026-10-02")]}})]);
  assert.equal(result.uniqueFixtureCount,0);assert.equal(result.fixtureIdentityConflicts,1);
  assert.equal(result.ticketCount,2);assert.equal(result.salesDayCount,2);
});
test("sample metadata never changes rows, ticket identities or cash", () => {
  const rows=[row(),row({batchIdentity:"real-2100",plan:{id:"score-single-2",status:"refunded",stake:2,simulatedReturn:2,items:[leg()]}})];
  const before=JSON.stringify(rows);
  Object.freeze(rows);rows.forEach(item=>{Object.freeze(item.riskPolicy);Object.freeze(item.plan.items[0]);Object.freeze(item.plan.items);Object.freeze(item.plan);Object.freeze(item);});
  const result=summarizePurchaseHistorySamples(rows);
  assert.equal(JSON.stringify(rows),before);assert.equal(result.ticketCount,2);
  assert.equal(Object.hasOwn(result,"stake"),false);assert.equal(Object.hasOwn(result,"returned"),false);
});

test("strategy history keeps real 17/21 purchases and unchanged legacy cash totals", () => {
  const policy={version:"paper-risk-v2",dailyBudget:100,maxFixtureStake:25};
  const plan={id:"score-single-2",status:"won",stake:2,simulatedReturn:20,items:[leg("a"),leg("b")]};
  const early={snapshotId:"actual-1700",date:"2026-10-01",generatedAt:"2026-10-01T09:00:00Z",scheduledTime:"17:00",decisionPolicy:"policy-v3",baseModelVersion:"model-v1",calibrationVersion:"cal-v1",riskSelection:{policy},plans:[plan]};
  const late={...early,snapshotId:"actual-2100",generatedAt:"2026-10-01T13:00:00Z",scheduledTime:"21:00",plans:[{...plan,status:"lost",simulatedReturn:0}]};
  const sets=[early,structuredClone(early),late],before=JSON.stringify(sets);
  const history=summarizePurchasePlanDefinitions(sets)["score-single-2"];
  assert.equal(history.rows.length,2);
  assert.deepEqual({settled:history.settled,won:history.won,stake:history.stake,returned:history.returned,net:history.net},{settled:2,won:1,stake:4,returned:20,net:16});
  assert.equal(history.samples.ticketCount,2);assert.equal(history.samples.batchCount,2);
  assert.equal(history.samples.uniqueFixtureCount,2);assert.equal(history.samples.salesDayCount,1);
  assert.equal(history.samples.versionGroups.length,1);
  assert.deepEqual(new Set(history.rows.map(row=>row.scheduledTime)),new Set(["17:00","21:00"]));
  assert.equal(JSON.stringify(sets),before);
});
test("legacy history with unknown fixture/model identity remains visible without invented samples", () => {
  const sets=[{snapshotId:"legacy-real-batch",date:"2026-09-19",generatedAt:"2026-09-19T09:39:00Z",plans:[{id:"score-single-2",status:"won",stake:2,simulatedReturn:12,items:[{matchId:"周六001"}]}]}];
  const history=summarizePurchasePlanDefinitions(sets)["score-single-2"];
  assert.equal(history.rows.length,1);assert.equal(history.stake,2);assert.equal(history.returned,12);
  assert.equal(history.samples.uniqueFixtureCount,0);assert.equal(history.samples.unidentifiedFixtureOccurrences,1);
  assert.equal(history.samples.versionGroups[0].baseModelVersion,null);
  assert.equal(history.samples.versionGroups[0].riskPolicy,null);
});
