import test from "node:test";
import assert from "node:assert/strict";
import { cloudCaptureReceipt, verifyCloudCaptureReceipt, verifyCloudCaptureReceiptRecord, verifyCloudRawRecord, recoverCloudCaptureReceipts } from "../app/cloud-capture-receipt.js";
import { cloudCaptureReadModel } from "../app/cloud-capture-read-model.js";
import { researchHash } from "../app/forward-validation.js";
import {slotProbabilityObservations} from "../app/slot-probability-observations.js";
import {comparePredictionSlots} from "../app/model-evaluation.js";

const raw = () => ({ recordType: "raw-prediction-snapshot", immutable: true, snapshotId: "raw-test",
  scheduledAt: "2026-10-02T13:00:00+08:00", capturedAt: "2026-10-02T12:50:00+08:00",
  reports: [{ officialMatchId: "123", kickoffAt: "2026-10-02T13:30:00+08:00" }],
  officialMatches: [{ officialMatchId: "123", matchStatus: "Selling", kickoffAt: "2026-10-02T13:30:00+08:00",
    marketEligibility: { HAD: { qualification: "qualified", salesStatus: "Selling", cutoffAt: "2026-10-02T13:20:00+08:00" } } }] });
const purchase = () => ({ recordType: "purchase-plan-snapshot", immutable: true, snapshotId: "purchase-test",
  scheduledAt: "2026-10-02T17:00:00+08:00", capturedAt: "2026-10-02T16:55:00+08:00",
  planSet: { plans: [{ items: [{ officialMatchId: "123", salesDate: "2026-10-02", market: "had", picks: [{ pick: "胜", odd: 2 }] }] }] },
  officialMatches: [{ officialMatchId: "123", salesDate: "2026-10-02", matchStatus: "Selling", kickoffAt: "2026-10-02T20:00:00+08:00",
    marketOdds: { "胜平负": [2, 3, 4] }, marketEligibility: { "胜平负": { qualification: "qualified", salesStatus: "Selling", allowedPassCounts: [1], cutoffAt: "2026-10-02T19:55:00+08:00" } } }] });
function memoryStore(records) {
  const data = new Map(records.map(record => [record.id, record]));
  return { data, canRecover: () => true, async read(id) { return data.get(id) || null; }, async append(record) { assert.ok(!data.has(record.id)); data.set(record.id, structuredClone(record)); },
    async *scan(type) { for (const record of [...data.values()]) if (record.type === type) yield record; } };
}

test("completion distinguishes target, kickoff, sales cutoff, and batch closing time", () => {
  assert.equal(cloudCaptureReceipt(raw(), "2026-10-02T12:51:00+08:00").includedInStrictEvaluation, true);
  const late = cloudCaptureReceipt(raw(), "2026-10-02T13:00:01+08:00");
  assert.equal(late.executionEligible, true); assert.equal(late.includedInStrictEvaluation, false);
  for (const time of ["2026-10-02T13:20:00+08:00", "2026-10-02T13:30:00+08:00"]) {
    const receipt = cloudCaptureReceipt(raw(), time); assert.equal(receipt.executionEligible, false); assert.equal(receipt.includedInStrictEvaluation, false);
  }
  assert.equal(cloudCaptureReceipt(purchase(), "2026-10-02T16:56:00+08:00").executionEligible, true);
  assert.equal(cloudCaptureReceipt(purchase(), "2026-10-02T18:41:00+08:00").executionEligible, false);
});

test("tampering with completion identity, timing, or eligibility is rejected", () => {
  const original = raw(), receipt = cloudCaptureReceipt(original, "2026-10-02T12:51:00+08:00");
  for (const patch of [{ rawHash: "x" }, { scheduledAt: "2026-10-02T14:00:00+08:00" }, { decisionTiming: "delayed-batch" },
    { recovered: true }, { includedInStrictEvaluation: false }, { executionEligible: false }, { persistedAt: "2026-10-02T12:49:00+08:00" }])
    assert.throws(() => verifyCloudCaptureReceipt(original, { ...receipt, ...patch }));
});

test("orphan recovery uses actual readback time, never rewrites raw or grants strict eligibility", async () => {
  const original = raw(), hash = researchHash(original), store = memoryStore([{ id: original.snapshotId, type: "raw", observedAt: original.capturedAt, payload: original }]);
  const recovered = await recoverCloudCaptureReceipts(store, () => "2026-10-02T12:52:00+08:00");
  assert.equal(recovered.length, 1); assert.equal(recovered[0].includedInStrictEvaluation, false);
  assert.equal(researchHash(store.data.get(original.snapshotId).payload), hash);
  const view = await cloudCaptureReadModel(store, { projectRaw: value => value, projectPurchase: value => value });
  assert.equal(view.snapshots[0].recovered, true); assert.equal(view.snapshots[0].includedInStrictEvaluation, false);
  assert.equal(view.snapshots[0].capturedAt, "2026-10-02T12:52:00+08:00");
  assert.equal((await recoverCloudCaptureReceipts(store, () => "2026-10-03T12:52:00+08:00")).length, 0);
});

test("expired purchase recovery remains visible as audit, not formal recommendation", async () => {
  const original = purchase(), store = memoryStore([{ id: original.snapshotId, type: "purchase", observedAt: original.capturedAt, payload: original }]);
  await recoverCloudCaptureReceipts(store, () => "2026-10-03T12:00:00+08:00");
  const view = await cloudCaptureReadModel(store, { projectRaw: value => value, projectPurchase: value => value });
  assert.equal(view.purchases.length, 0); assert.equal(view.auditPurchases.length, 1);
  assert.equal(view.auditPurchases[0].formalRecommendationEligible, false);
  assert.equal(view.auditPurchases[0].persistedAt, "2026-10-03T12:00:00+08:00");
});

for(const recovered of [false,true]) test(`excluded purchase retains complete frozen probability evidence, recovered=${recovered}`,async()=>{
  const original=purchase(), points=labels=>labels.map(score=>({score,probability:100/labels.length}));
  original.forecasts=[{officialMatchId:"123",salesDate:"2026-10-02",kickoffAt:"2026-10-02T20:00:00+08:00",
    baseModelVersion:"test-model",calibrationVersion:"test-calibration",
    fullScoreDistribution:points(Array.from({length:169},(_,i)=>`${Math.floor(i/13)}:${i%13}`)),
    hadProbabilities:points(["胜","平","负"]),hhadProbabilities:points(["让胜","让平","让负"]),
    totalGoalProbabilities:points(["0球","1球","2球","3球","4球","5球","6球","7+球"]),
    halfFullProbabilities:points(["胜胜","胜平","胜负","平胜","平平","平负","负胜","负平","负负"])}];
  const rawHash=researchHash(original), persistedAt="2026-10-02T18:41:00+08:00";
  const store=memoryStore([{id:original.snapshotId,type:"purchase",observedAt:original.capturedAt,payload:original}]);
  if(recovered) await recoverCloudCaptureReceipts(store,()=>persistedAt);
  else {
    const receipt=cloudCaptureReceipt(original,persistedAt);
    await store.append({id:`raw-receipt-${original.snapshotId}`,type:"receipt",observedAt:persistedAt,payload:receipt});
  }
  const projectPurchase=value=>({snapshotId:value.snapshotId,evaluationSnapshot:{snapshotId:value.snapshotId,date:"2026-10-02",
    scheduledAt:value.scheduledAt,capturedAt:value.capturedAt,matches:value.forecasts}});
  const view=await cloudCaptureReadModel(store,{projectRaw:value=>value,projectPurchase});
  assert.equal(view.purchases.length,0);assert.equal(view.auditPurchases.length,1);
  assert.equal(view.probabilitySnapshots.length,1);
  const evidence=view.probabilitySnapshots[0], forecast=evidence.matches[0];
  assert.equal(evidence.persistedAt,persistedAt);assert.equal(evidence.recovered,recovered);
  assert.equal(evidence.executionEligible,false);assert.equal(evidence.includedInStrictEvaluation,false);
  assert.equal(forecast.fullScoreDistribution.length,169);assert.equal(forecast.hadProbabilities.length,3);
  assert.equal(forecast.hhadProbabilities.length,3);assert.equal(forecast.totalGoalProbabilities.length,8);assert.equal(forecast.halfFullProbabilities.length,9);
  assert.equal(researchHash(store.data.get(original.snapshotId).payload),rawHash);
  assert.deepEqual((await cloudCaptureReadModel(store,{projectRaw:value=>value,projectPurchase})).probabilitySnapshots,view.probabilitySnapshots);
  assert.equal(comparePredictionSlots(slotProbabilityObservations(view.probabilitySnapshots,[])).commonFixtures,0);
});

test("valid payload hashes cannot hide swapped IDs, record types or observation times", () => {
  const original = raw(), receipt = cloudCaptureReceipt(original, "2026-10-02T12:51:00+08:00");
  const record = { id: `raw-receipt-${original.snapshotId}`, type: "receipt", observedAt: receipt.persistedAt, payload: receipt };
  assert.equal(verifyCloudCaptureReceiptRecord(original, record), receipt);
  for (const patch of [{ id: "other-receipt" }, { type: "raw" }, { observedAt: original.capturedAt }])
    assert.throws(() => verifyCloudCaptureReceiptRecord(original, { ...record, ...patch }));
  const rawRecord = { id: original.snapshotId, type: "raw", observedAt: original.capturedAt, payload: original };
  assert.equal(verifyCloudRawRecord(rawRecord), original);
  for (const patch of [{ id: "other-raw" }, { type: "purchase" }, { observedAt: receipt.persistedAt }])
    assert.throws(() => verifyCloudRawRecord({ ...rawRecord, ...patch }));
});
