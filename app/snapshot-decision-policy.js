const SHANGHAI_OFFSET="+08:00";

export function decisionTargetAt(salesDate,kickoffAt){
 const kickoff=Date.parse(String(kickoffAt||""));
 if(!/^\d{4}-\d{2}-\d{2}$/.test(String(salesDate||""))||!Number.isFinite(kickoff))return null;
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
  const capturedAt=String(snapshot.capturedAt||snapshot.sourceFetchedAt||"");
  const scheduledMs=Date.parse(scheduledAt),capturedMs=Date.parse(capturedAt),targetMs=Date.parse(targetAt||"");
  // 定时任务可能在计划时点后数分钟才完成。正式复盘按不可变快照的计划采集
  // 时间归档，同时保留 capturedAt 展示实际完成时间；旧快照没有 scheduledAt
  // 时才退回实际采集时间，避免把赛后生成的数据伪装成赛前记录。
  const decisionMs=Number.isFinite(scheduledMs)?scheduledMs:capturedMs;
  if(!targetAt||!Number.isFinite(capturedMs)||!Number.isFinite(decisionMs)||decisionMs>targetMs)continue;
  const matchKey=String(match.officialMatchId||`${salesDate}|${match.id}|${match.home}|${match.away}`);
  const key=`${salesDate}|${matchKey}`,candidate={snapshot,match,salesDate,targetAt,scheduledAt,capturedAt,decisionMs,matchKey};
  const current=groups.get(key);
  if(!current||current.decisionMs<decisionMs||(current.decisionMs===decisionMs&&Date.parse(current.capturedAt)<capturedMs))groups.set(key,candidate);
 }
 return [...groups.values()];
}
