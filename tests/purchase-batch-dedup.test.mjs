import test from 'node:test';
import assert from 'node:assert/strict';
import {deduplicatePurchasePlanSets,summarizePurchasePlanDays} from '../app/purchase-plan-engine.js';
const plan={id:'had-2',status:'lost',items:[{matchId:'001'}],stake:2,simulatedReturn:0};
const batch=(id,time,extra={})=>({snapshotId:id,date:'2026-10-11',scheduledTime:'17:00',generatedAt:`2026-10-11T${time}:00+08:00`,plans:[plan],...extra});
test('one date, slot and method is counted once; slots and dates remain separate',()=>{
 const rows=[batch('first','16:45',{plans:[plan,{...plan}]}),batch('retry','17:20',{captureTiming:'delayed'}),batch('night','20:45',{scheduledTime:'21:00'}),batch('next','16:45',{date:'2026-10-12'})];
 const result=deduplicatePurchasePlanSets(rows);
 assert.equal(result.length,3);assert.equal(result.find(r=>r.snapshotId==='first').plans.length,1);
 assert.equal(summarizePurchasePlanDays(rows)['2026-10-11'].settled,2);
 assert.deepEqual(deduplicatePurchasePlanSets(result),result);
});
test('complete coverage replaces partial retry, but winning results never choose a batch',()=>{
 const rows=[batch('partial','16:45',{qualityStatus:'partial'}),batch('complete','16:50',{qualityStatus:'cutoff-unknown',captureTiming:'on-time'}),batch('late-winner','17:20',{captureTiming:'delayed',plans:[{...plan,status:'won',simulatedReturn:100}]})];
 assert.equal(deduplicatePurchasePlanSets(rows)[0].snapshotId,'complete');
 assert.equal(deduplicatePurchasePlanSets([...rows].reverse())[0].snapshotId,'complete');
 assert.equal(rows.length,3);assert.equal(rows[2].plans[0].simulatedReturn,100);
});
test('ordinary manual trials remain separate from fixed batches',()=>{
 assert.equal(deduplicatePurchasePlanSets([batch('trial-a','19:00',{scheduledTime:'19:00'}),batch('trial-b','19:01',{scheduledTime:'19:01'})]).length,2);
});
