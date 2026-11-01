import test from "node:test";
import assert from "node:assert/strict";
import {cloudBatchIdentity, inspectCloudBatch} from "../scripts/cloud-capture-guard.mjs";

const identity = {namespace:"production", date:"2026-11-01", type:"purchase", slot:"1700"};
const batch = cloudBatchIdentity(identity);
test("purchase keeps 1700 identity but opens at 17:10 Shanghai", () => {
  assert.equal(batch.scheduledAt, "2026-11-01T17:10:00+08:00");
  assert.equal(new Date(batch.opensAt).toISOString(), "2026-11-01T09:10:00.000Z");
  assert.equal(batch.key, "production|2026-11-01|purchase|1700");
  assert.equal(cloudBatchIdentity({...identity,slot:"2100"}).scheduledAt,"2026-11-01T21:10:00+08:00");
});
test("no early or late capture, including exact exclusive window end", () => {
  for (const [now,status] of [[batch.opensAt-1,"not-due"],[batch.opensAt,"atomic-claim-required"],[batch.closesAt-1,"atomic-claim-required"],[batch.closesAt,"missed-no-capture"],[batch.closesAt+86400000,"missed-no-capture"]]) {
    assert.equal(inspectCloudBatch(identity,{now,cutoverVerified:true}).status,status);
  }
});
test("production stays closed without verified ownership cutover", () => {
  assert.equal(inspectCloudBatch(identity,{now:batch.opensAt}).status,"cutover-blocked");
});
test("test namespace is separate; it grants no production activation", () => {
  const isolated = {...identity,namespace:"test-readback"};
  assert.notEqual(cloudBatchIdentity(isolated).key,batch.key);
  assert.equal(inspectCloudBatch(isolated,{now:batch.opensAt}).status,"atomic-claim-required");
  assert.throws(()=>cloudBatchIdentity({...identity,namespace:"test"}),/namespace/);
  assert.throws(()=>cloudBatchIdentity({...identity,namespace:"test-../production"}),/namespace/);
});
test("complete and failed/missed records never trigger recapture", () => {
  for (const [status,expected] of [["complete","readback-required"],["failed","terminal-no-retry"],["missed","terminal-no-retry"],["running","observe-only"]]) {
    const existing = {key:batch.key,status};
    const before=JSON.stringify(existing);
    assert.equal(inspectCloudBatch(identity,{now:batch.opensAt,existing,cutoverVerified:true}).status,expected);
    assert.equal(JSON.stringify(existing),before);
  }
});
test("stale observations cannot accidentally deduplicate another slot", () => {
  assert.throws(()=>inspectCloudBatch(identity,{now:batch.opensAt,existing:{key:"other",status:"complete"}}),/identity mismatch/);
  assert.throws(()=>inspectCloudBatch(identity,{now:batch.opensAt,existing:{key:batch.key,status:"retry"}}),/fail closed/);
});
test("all five daily slots and one result slot are exact", () => {
  for(const slot of ["1330","1530","1730","1930","2130"]) assert.equal(cloudBatchIdentity({...identity,type:"daily",slot}).scheduledAt,`2026-11-01T${slot.slice(0,2)}:${slot.slice(2)}:00+08:00`);
  assert.equal(cloudBatchIdentity({...identity,type:"results",slot:"1000"}).scheduledAt,"2026-11-01T10:00:00+08:00");
});
test("invalid dates, arbitrary slots, prototype keys and missing clock fail closed", () => {
  for(const date of ["2026-02-30","2026-13-01","2026-1-1"]) assert.throws(()=>cloudBatchIdentity({...identity,date}),/date/);
  for(const slot of ["1710","1900","constructor"]) assert.throws(()=>cloudBatchIdentity({...identity,slot}),/slot/);
  assert.throws(()=>cloudBatchIdentity({...identity,type:"__proto__"}),/slot/);
  assert.throws(()=>inspectCloudBatch(identity),/clock/);
});
