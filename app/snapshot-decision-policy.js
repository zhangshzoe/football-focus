const SHANGHAI_OFFSET="+08:00";

export function decisionTargetAt(salesDate,kickoffAt){
 const kickoff=Date.parse(String(kickoffAt||""));
 if(!/^\d{4}-\d{2}-\d{2}$/.test(String(salesDate||""))||!/(?:Z|[+-]\d{2}:\d{2})$/.test(String(kickoffAt||""))||!Number.isFinite(kickoff))return null;
 const weekday=new Date(`${salesDate}T12:00:00${SHANGHAI_OFFSET}`).getUTCDay();
 const weekend=weekday===0||weekday===6;
 const cutoff=Date.parse(`${salesDate}T${weekend?"23:00":"22:00"}:00${SHANGHAI_OFFSET}`);
 const fixed=Date.parse(`${salesDate}T${weekend?"22:30":"21:30"}:00${SHANGHAI_OFFSET}`);
 return new Date(kickoff>=cutoff?fixed:kickoff-30*60*1000).toISOString();
}

export function selectOfficialDecisionRows(snapshots){
 const groups=new Map();
 for(const snapshot of snapshots||[])for(const match of snapshot?.matches||[]){
  const salesDate=String(match.salesDate||snapshot.date||"");
  const targetAt=decisionTargetAt(salesDate,match.kickoffAt||match.matchDate||match.time);
  const scheduledAt=String(snapshot.scheduledAt||"");
  const capturedAt=String(match.selectedCapturedAt||match.archiveCapturedAt||snapshot.capturedAt||snapshot.sourceFetchedAt||"");
  const capturedMs=Date.parse(capturedAt),targetMs=Date.parse(targetAt||""),kickoffMs=Date.parse(match.kickoffAt||"");
  // A scheduled job time is not evidence that its inputs existed then. Merged
  // daily projections must retain the individual fixture's actual capture time.
  const informationMs=Math.max(capturedMs,...[match.predictionGeneratedAt,match.modelInput?.decisionAt,match.sourceFetchedAt].filter(Boolean).map(value=>Date.parse(value)));
  const decisionMs=informationMs;
  if(!String(match.officialMatchId||"").trim()||!targetAt||!Number.isFinite(informationMs)||informationMs>targetMs||informationMs>=kickoffMs)continue;
  const matchKey=String(match.officialMatchId||`${salesDate}|${match.id}|${match.home}|${match.away}`);
  const key=`${salesDate}|${matchKey}`,candidate={snapshot,match,salesDate,targetAt,scheduledAt,capturedAt,decisionMs,matchKey};
  const current=groups.get(key);
  if(!current||current.decisionMs<decisionMs||(current.decisionMs===decisionMs&&Date.parse(current.capturedAt)<capturedMs))groups.set(key,candidate);
 }
 return [...groups.values()];
}

// One shared policy for diagnostics and calibration; never de-duplicate before
// this function, since a later or more complete row can be past the decision.
export function selectDecisionObservations(rows){
 const groups=new Map(),excluded=[];
 for(const row of rows||[]){
  const salesDate=String(row.salesDate||row.matchKey?.match(/^\d{4}-\d{2}-\d{2}/)?.[0]||"");
  const key=String(row.officialMatchId?`${salesDate}|${row.officialMatchId}`:row.matchKey||row.key||"");
  const targetAt=decisionTargetAt(salesDate,row.kickoffAt),capturedAt=String(row.selectedCapturedAt||row.capturedAt||"");
  const times=[capturedAt,row.predictionGeneratedAt,row.modelInput?.decisionAt,row.sourceFetchedAt].filter(Boolean).map(value=>Date.parse(value));
  const availableAt=times.length?Math.max(...times):NaN,kickoff=Date.parse(row.kickoffAt||"");
  let reason="";
  if(!key||!salesDate)reason="missing-identity";
  else if(!targetAt||!Number.isFinite(Date.parse(capturedAt))||!Number.isFinite(availableAt))reason="missing-time";
  else if(availableAt>=kickoff)reason="not-pre-match";
  else if(availableAt>Date.parse(targetAt))reason="after-decision";
  if(reason){excluded.push({key,reason,capturedAt,targetAt});continue;}
  const current=groups.get(key),candidate={...row,salesDate,capturedAt,decisionTargetAt:targetAt,informationAvailableAt:new Date(availableAt).toISOString()};
  if(!current||availableAt>Date.parse(current.informationAvailableAt)||(availableAt===Date.parse(current.informationAvailableAt)&&String(row.snapshotId||row.predictionId||"")>String(current.snapshotId||current.predictionId||"")))groups.set(key,candidate);
 }
 return{rows:[...groups.values()].sort((a,b)=>Date.parse(a.kickoffAt)-Date.parse(b.kickoffAt)),excluded,policy:"actual_information_not_after_fixed_target_v2"};
}
