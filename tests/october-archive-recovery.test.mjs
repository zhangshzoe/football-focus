import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {buildArchiveRecoverySnapshots} from '../app/archive-recovery.js';
import recovery from '../data/archive-recovery/2026-10-06.json' with {type:'json'};

test('October 6 missing rows preserve the authentic forecast and exclude strict evaluation',async()=>{
 const bytes=await readFile(new URL('../'+recovery.sourcePath,import.meta.url));
 const source=JSON.parse(bytes);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),recovery.sourceSha256);
 assert.equal(recovery.includedInStrictEvaluation,false);
 for(const match of recovery.matches){
  const report=source.forecasts.find(row=>row.officialMatchId===match.officialMatchId);
  assert.deepEqual(match.fullScoreDistribution,report.fullScoreDistribution);
  assert.deepEqual(match.hadProbabilities.map(row=>row.probability),[report.probabilities.home,report.probabilities.draw,report.probabilities.away]);
  assert.deepEqual(match.halfFullProbabilities.map(row=>row.probability),report.marketSignal.modeledHalfFull);
  assert.equal(match.archiveCapturedAt,source.capturedAt);
  assert.equal(match.predictionGeneratedAt,report.predictionGeneratedAt);
 }
 const [snapshot]=buildArchiveRecoverySnapshots([],[],['2026-10-06']);
 assert.equal(snapshot.storageOrigin,'recovered');
 assert.deepEqual(snapshot.matches.map(row=>row.id),['周二001','周二002']);
 assert.ok(snapshot.matches.every(row=>row.archiveEvidence==='purchase_forecast'));
});

test('formal rows take priority and unsupported dates are never backfilled',()=>{
 const formal={date:'2026-10-06',snapshotId:'2026-10-06-official-decision-v1',matches:[{...recovery.matches[0],predictionId:'formal-original'}]};
 const [snapshot]=buildArchiveRecoverySnapshots([formal],[],['2026-10-06']);
 assert.equal(snapshot.matches[0].predictionId,'formal-original');
 assert.equal(snapshot.matches[0].archiveEvidence,'formal');
 assert.deepEqual(buildArchiveRecoverySnapshots([],[],['2026-10-09','2026-10-10']),[]);
});

test('October 5 index restores all seven original rows without recomputing probabilities',async()=>{
 const raw=JSON.parse(await readFile(new URL('../data/prediction-snapshots/2026-10-05_2130.raw.json',import.meta.url)));
 const bundle=JSON.parse(await readFile(new URL('../data/generated-prediction-snapshot-index.json',import.meta.url)));
 const day=bundle.snapshots.find(row=>row.snapshotId==='2026-10-05-official-decision-v1');
 assert.equal(day.matches.length,7);
 for(const match of day.matches){
  const report=raw.reports.find(row=>row.officialMatchId===match.officialMatchId);
  assert.equal(match.selectedCapturedAt,raw.capturedAt);
  assert.deepEqual(match.fullScoreDistribution,report.fullScoreDistribution);
 }
});
