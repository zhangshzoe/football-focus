import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {decisionTargetAt} from '../app/snapshot-decision-policy.js';

// Projection only: never compute new predictions or alter the source capture.
const sourcePath='data/purchase-plan-snapshots/2026-10-06_175734_9e1d80cb3bc3.json';
const bytes=await readFile(sourcePath);
const source=JSON.parse(bytes);
if(source.immutable!==true||source.recordType!=='purchase-plan-snapshot')throw new Error('Not an immutable source');
const points=(labels,values)=>labels.map((score,index)=>({score,probability:values[index]}));
const matches=source.forecasts.filter(report=>['周二001','周二002'].includes(report.id)).map(report=>{
 const target=Date.parse(decisionTargetAt(report.salesDate,report.kickoffAt));
 if(report.isMock||!report.officialMatchId||report.salesDate!=='2026-10-06'||Date.parse(source.capturedAt)>target||Date.parse(report.predictionGeneratedAt)>target||report.fullScoreDistribution?.length!==169)throw new Error('Invalid retained forecast');
 return {
  id:report.id,officialMatchId:report.officialMatchId,salesDate:report.salesDate,kickoffAt:report.kickoffAt,
  league:report.league,home:report.home,away:report.away,time:report.time,matchDate:report.matchDate,
  predictionId:report.predictionId,inputSnapshotId:report.inputSnapshotId,baseModelVersion:report.baseModelVersion,calibrationVersion:report.calibrationVersion,
  predictionGeneratedAt:report.predictionGeneratedAt,sourceFetchedAt:report.sourceFetchedAt,generatedAt:source.capturedAt,
  isMock:false,fullScoreDistribution:report.fullScoreDistribution,combinedScores:report.fullScoreDistribution,oddsScores:[],
  expectedGoals:report.expectedGoals,hadProbabilities:points(['胜','平','负'],[report.probabilities.home,report.probabilities.draw,report.probabilities.away]),
  hhadProbabilities:points(['让胜','让平','让负'],report.marketSignal.modeledHhad),
  totalGoalProbabilities:points(['0球','1球','2球','3球','4球','5球','6球','7+球'],report.marketSignal.modeledTotalGoals),
  halfFullProbabilities:points(['胜胜','胜平','胜负','平胜','平平','平负','负胜','负平','负负'],report.marketSignal.modeledHalfFull),
  handicap:report.marketSignal.officialHandicap,confidence:report.consensus?.agreement==='较一致'?82:64,completeness:Math.max(1,10-(report.missingCompanies?.length||0)),
  archiveEvidence:'purchase_forecast',archiveCapturedAt:source.capturedAt,archiveSourceSnapshotId:source.snapshotId,
 };
});
if(matches.length!==2)throw new Error('Expected two authentic missing forecasts');
const recovery={schemaVersion:1,date:'2026-10-06',sourcePath,sourceSha256:createHash('sha256').update(bytes).digest('hex'),sourceSnapshotId:source.snapshotId,capturedAt:source.capturedAt,includedInStrictEvaluation:false,matches};
await mkdir('data/archive-recovery',{recursive:true});
await writeFile('data/archive-recovery/2026-10-06.json',JSON.stringify(recovery)+'\n',{flag:'wx'});
console.log(JSON.stringify({date:recovery.date,matches:matches.map(row=>row.id),capturedAt:recovery.capturedAt,sourceSha256:recovery.sourceSha256}));
