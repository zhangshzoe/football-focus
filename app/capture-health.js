const dated = value => /^\d{4}-\d{2}-\d{2}$/.test(value || "");
const identity = record => `${record.salesDate}|${record.kind}|${record.slot}`;
export function compactCaptureAttempts(input) {
  const events = new Map();
  for (const record of input || []) {
    if (record.recordType !== "capture-attempt" || record.immutable !== true ||
      !dated(record.salesDate) || !record.attemptId || !Number.isFinite(Date.parse(record.completedAt))) continue;
    if (!events.has(record.attemptId)) events.set(record.attemptId, record);
  }
  const groups = new Map();
  for (const record of events.values()) groups.set(identity(record), [...(groups.get(identity(record)) || []), record]);
  return [...groups.values()].map(records => {
    records.sort((a,b) => a.completedAt.localeCompare(b.completedAt));
    const latest = records.at(-1), outcomes = {}, manifests = new Map();
    for (const record of records) {
      outcomes[record.outcome] = (outcomes[record.outcome] || 0) + 1;
      for (const fixture of record.officialManifest || []) if (fixture.officialMatchId && dated(fixture.salesDate) && Number.isFinite(Date.parse(fixture.kickoffAt)))
        manifests.set(JSON.stringify([fixture.salesDate,String(fixture.officialMatchId),Date.parse(fixture.kickoffAt),fixture.home||null,fixture.away||null]), fixture);
    }
    const success = records.filter(r => ["saved","no_ticket","existing"].includes(r.outcome) && r.snapshotId).at(-1);
    return {recordType:"capture-attempt-summary",salesDate:latest.salesDate,kind:latest.kind,slot:latest.slot,
      scheduledAt:latest.scheduledAt,startedAt:latest.startedAt,completedAt:latest.completedAt,outcome:latest.outcome,
      stage:latest.stage,reason:latest.reason,sourceCode:latest.sourceCode,sourceState:latest.sourceState,coverage:latest.coverage,attemptCount:records.length,outcomes,
      snapshotId:success?.snapshotId,successfulOutcome:success?.outcome,successfulCompletedAt:success?.completedAt,
      officialManifest:[...manifests.values()],unknownManifestAttempts:records.filter(r=>r.officialManifest===null).length};
  }).sort((a,b)=>b.completedAt.localeCompare(a.completedAt));
}

export function purchaseCaptureState(date,slot,attempts,sets,now=Date.now()) {
  const empty = {actualAt:null,delaySeconds:null,reason:""};
  const time = slot === "2100" ? "21:00" : "17:00";
  const records = (attempts || []).filter(r=>r.salesDate===date&&r.kind==="purchase"&&r.slot===slot);
  const attempt = records.sort((a,b)=>String(b.completedAt).localeCompare(String(a.completedAt)))[0];
  const snapshot = (sets || []).find(set=>set.date===date&&set.scheduledTime===time);
  const expectedAt = Date.parse(`${date}T${time}:00+08:00`);
  if (snapshot) {
    const actualAt=snapshot.completedAt||snapshot.generatedAt,actualMs=Date.parse(actualAt||"");
    if(!Number.isFinite(actualMs)||!Number.isFinite(expectedAt))return {...empty,state:"unverified_time",label:"已有留档，实际时刻待核验",reason:"不能把计划时间替代实际采集时间"};
    return {state:snapshot.decisionSummary?.noBet?"no_ticket":"saved",label:snapshot.decisionSummary?.noBet?"已评估，不投注":"已留档",actualAt,delaySeconds:Math.max(0,(actualMs-expectedAt)/1000),reason:attempt?.reason||""};
  }
  if (attempt?.successfulOutcome === "no_ticket") return {...empty,state:"no_ticket",label:"已评估，不投注 · 索引待同步",actualAt:attempt.successfulCompletedAt||null};
  if (attempt) return {...empty,state:attempt.outcome,label:({saved:"已采集，索引待同步",existing:"已有留档，索引待同步",failed:"采集失败",late:"超过时限",incomplete_evaluation:"评估不完整",skipped:"已检查，未留档"})[attempt.outcome]||"已检查，未留档",actualAt:attempt.completedAt,reason:attempt.reason||""};
  return {...empty,state:now<expectedAt?"not_due":"missing_evidence",label:now<expectedAt?"尚未到时":"没有执行证据",reason:"不按未中奖计入；未运行和日志缺失目前无法区分"};
}
