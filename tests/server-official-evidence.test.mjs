import test from "node:test";
import assert from "node:assert/strict";
import {resolveServerOfficialMatches} from "../app/server-official-evidence.js";

// Synthetic response fixtures remain in memory; never written as real snapshots.
const at="2026-10-01T08:45:00.000Z",date="2026-10-01",now=Date.parse(at);
function fixture(){
 const match={officialMatchId:"123",matchId:"123",salesDate:date,kickoffAt:"2026-10-01T23:00:00+08:00",odds:[2,3,4],marketOdds:{"让球胜平负":[3,3,2],"总进球数":[12,8,4,3,6,12,20,30]},marketEligibility:{"让球胜平负":{qualification:"qualified"}}};
 const input={officialMatchId:"123",salesDate:date,kickoffAt:match.kickoffAt,fetchedAt:at,hadOdds:match.odds,hhadOdds:match.marketOdds["让球胜平负"],totalOdds:match.marketOdds["总进球数"],scoreOdds:[],halfFullOdds:[]};
 const report={officialMatchId:"123",officialMappingStatus:"verified",officialVerification:{method:"server-refetch",fetchedAt:at},modelInput:{official:input}};
 return {selection:[{officialMatchId:"123",odds:[99,99,99]}],prediction:{officialSource:{method:"server-refetch",fetchedAt:at,manifestState:"complete",poolStatus:Object.fromEntries(["HAD","HHAD","CRS","TTG","HAFU"].map(pool=>[pool,{status:"success",observedAt:at}]))},officialMatches:[match],reports:[report]}};
}
test("capture uses server quotes rather than the earlier client/list quotes",()=>{
 const {prediction,selection}=fixture();
 const matches=resolveServerOfficialMatches(prediction,selection,date,now);
 assert.deepEqual(matches[0].odds,[2,3,4]);
 assert.equal(matches,prediction.officialMatches);
});

test("formal capture rejects incomplete five-market rereads even with matching quotes",()=>{
 for(const change of [s=>delete s.manifestState,s=>s.manifestState="partial",s=>s.manifestState="unknown",s=>delete s.poolStatus,s=>delete s.poolStatus.CRS,s=>s.poolStatus.TTG.status="failed"]){
  const {prediction,selection}=fixture();change(prediction.officialSource);
  assert.throws(()=>resolveServerOfficialMatches(prediction,selection,date,now),/完整五玩法.*读取证明/);
 }
 const {prediction,selection}=fixture();
 prediction.officialSource.poolStatus.HAD.issues=[{source:"primary",kind:"access-blocked",httpStatus:567,detail:"blocked"}];
 assert.equal(resolveServerOfficialMatches(prediction,selection,date,now),prediction.officialMatches);
});
test("missing, future and stale server observation times fail closed",()=>{
 for(const fetchedAt of [null,"bad-time",new Date(now+1).toISOString(),new Date(now-300001).toISOString()]){
  const {prediction,selection}=fixture();prediction.officialSource.fetchedAt=fetchedAt;
  assert.throws(()=>resolveServerOfficialMatches(prediction,selection,date,now),/读取证明/);
 }
 const {prediction,selection}=fixture();delete prediction.officialSource;
 assert.throws(()=>resolveServerOfficialMatches(prediction,selection,date,now),/读取证明/);
});
test("incomplete, duplicate, mock and wrong-day official universes cannot be frozen",()=>{
 for(const change of [p=>p.officialMatches=[],p=>p.officialMatches.push(p.officialMatches[0]),p=>p.officialMatches[0].officialMatchId="456",p=>p.officialMatches[0].isMock=true,p=>p.officialMatches[0].salesDate="2026-10-02",p=>p.officialMatches[0].kickoffAt="bad-time"]){
  const {prediction,selection}=fixture();change(prediction);
  assert.throws(()=>resolveServerOfficialMatches(prediction,selection,date,now),/清单覆盖|身份/);
 }
});

test("a fresh global timestamp cannot refresh a missing or stale pool observation",()=>{
 for(const observedAt of [undefined,"bad-time",new Date(now+1).toISOString(),new Date(now-300001).toISOString()]){
  const {prediction,selection}=fixture();prediction.officialSource.poolStatus.TTG.observedAt=observedAt;
  assert.throws(()=>resolveServerOfficialMatches(prediction,selection,date,now),/逐玩法新鲜读取证明/);
 }
});
test("each frozen forecast must retain the same identity, server time and all five quotes",()=>{
 for(const change of [r=>r.officialMappingStatus="pending_verification",r=>r.officialMatchId="456",r=>delete r.officialVerification,r=>r.modelInput.official.fetchedAt="later",r=>r.modelInput.official.hadOdds=[99,99,99],r=>r.modelInput.official.totalOdds=Array(8).fill(99),r=>r.modelInput.official.scoreOdds=[1],r=>r.modelInput.official.halfFullOdds=[1],r=>r.modelInput.official.hhadOdds=[99,99,99]]){
  const {prediction,selection}=fixture();change(prediction.reports[0]);
  assert.throws(()=>resolveServerOfficialMatches(prediction,selection,date,now),/读取证明|赔率/);
 }
 const {prediction,selection}=fixture();prediction.reports.push(prediction.reports[0]);
 assert.throws(()=>resolveServerOfficialMatches(prediction,selection,date,now),/读取证明/);
});
