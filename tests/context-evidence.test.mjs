import test from "node:test";
import assert from "node:assert/strict";
import {signContextProof,resolveContextEvidence,validateEvidenceReviews,applyEvidenceReviews} from "../app/context-evidence.js";
const at="2026-10-01T17:00:00+08:00",secret="test-only-signing-key";
const report={id:"周四001",predictionId:"p",inputSnapshotId:"i",officialMatchId:"123",officialMappingStatus:"verified",home:"h",away:"a",kickoffAt:"2026-10-01T22:00:00+08:00",fullScoreDistribution:[{score:"1:0",probability:12.3}],hadProbabilities:[{score:"胜",probability:52.2}],modelInput:{matchContext:{status:"partial",observedAt:at,missing:["非点球xG"],injuries:[{player:"p",replacementImpact:null,sourceUrl:"https://www.sporttery.cn/evidence",observedAt:at}]}}};
test("signed context accepts original identity and rejects tampering, future and missing proof",async()=>{
 const row={...report,contextProof:await signContextProof(report,secret)};
 assert.equal((await resolveContextEvidence(row,secret,at)).status,"verified-frozen-context");
 assert.equal((await resolveContextEvidence({...row,home:"other"},secret,at)).status,"unverified");
 assert.equal((await resolveContextEvidence(report,secret,at)).status,"unverified");
 assert.equal((await resolveContextEvidence(row,secret,"2026-10-01T16:59:00+08:00")).status,"unverified");
});
test("evidence review cannot invent references or alter numeric probabilities",async()=>{
 const row={...report,contextProof:await signContextProof(report,secret)};
 const context=await resolveContextEvidence(row,secret,at),inputs=[{id:row.id,context}],review={id:row.id,facts:[{text:"invented result",evidenceIds:["e1"]}],conflicts:[],checks:[]};
 const reviews=validateEvidenceReviews([review],inputs);
 assert.ok(!reviews[0].facts[0].text.includes("invented"));
 assert.throws(()=>validateEvidenceReviews([{...review,id:"other"}],inputs));
 assert.throws(()=>validateEvidenceReviews([{...review,checks:[{text:"unknown",evidenceIds:["e9"]}]}],inputs));
 const version={predictionId:"p",generatedAt:at},result=applyEvidenceReviews(version,[row],reviews,"AI","test",at);
 assert.deepEqual(result.reports[0].fullScoreDistribution,row.fullScoreDistribution);
 assert.deepEqual(result.reports[0].hadProbabilities,row.hadProbabilities);
 assert.equal(result.version.predictionId,version.predictionId);assert.equal(result.version.generatedAt,version.generatedAt);
 assert.equal(result.reports[0].shadowFullScoreDistribution,undefined);
});
