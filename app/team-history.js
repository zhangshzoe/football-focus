import {createHash} from "node:crypto";
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function buildTeamHistoryIndex(snapshots){
  const versions=new Map();let excluded=0;
  for(const snapshot of snapshots)for(const report of snapshot.reports||[]){
    if(snapshot.immutable!==true||report.isMock||report.officialMappingStatus!=="verified")continue;
    for(const fixture of report.modelInput?.matchContext?.fixtures||[]){
      const observed=Date.parse(fixture.observedAt),completed=Date.parse(fixture.completedBefore),captured=Date.parse(snapshot.capturedAt);
      if(!fixture.homeTeamId||!fixture.awayTeamId||!fixture.league||!/^https:\/\//.test(fixture.sourceUrl||"")||!Number.isFinite(observed)||!Number.isFinite(completed)||observed>captured||completed>=observed||![fixture.homeGoals,fixture.awayGoals].every(v=>Number.isInteger(v)&&v>=0)){excluded++;continue;}
      const key=`${fixture.league}|${fixture.date}|${fixture.homeTeamId}|${fixture.awayTeamId}`;
      const contentHash=hash({key,homeGoals:fixture.homeGoals,awayGoals:fixture.awayGoals});
      const row={...fixture,key,contentHash,sourceSnapshotId:snapshot.snapshotId};
      const versionKey=key+"|"+contentHash,current=versions.get(versionKey);
      if(!current||Date.parse(current.observedAt)>observed)versions.set(versionKey,row);
    }
  }
  const rows=[...versions.values()].sort((a,b)=>a.key.localeCompare(b.key)||a.observedAt.localeCompare(b.observedAt)||a.contentHash.localeCompare(b.contentHash));
  return {schemaVersion:1,historyVersion:hash(rows),policy:"immutable-observed-history-v1",rows,excluded};
}
export function selectTeamHistory(index,{league,decisionAt}){
  const cutoff=Date.parse(decisionAt),groups=new Map();
  for(const row of index.rows||[]){
    if(row.league!==league||Date.parse(row.observedAt)>cutoff||Date.parse(row.completedBefore)>=cutoff)continue;
    groups.set(row.key,[...(groups.get(row.key)||[]),row]);
  }
  const rows=[],conflicts=[];
  for(const [key,versions] of groups){if(new Set(versions.map(r=>r.contentHash)).size>1)conflicts.push(key);else rows.push(versions[0]);}
  rows.sort((a,b)=>a.key.localeCompare(b.key));
  return {historyVersion:index.historyVersion,historyAsOf:decisionAt,sampleHash:hash(rows),sampleIds:rows.map(r=>r.contentHash),rows,conflicts,coverage:"observed-archive-not-complete-league",usesCurrentRequest:false};
}
