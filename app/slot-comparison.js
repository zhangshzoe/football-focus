import {mergePurchaseBatches} from "./purchase-batch-policy.js";
import {settledTicketCash} from "./ticket-economics.js";

const millis=value=>Date.parse(value||"");
export function batchInformationTime(set) {
  const times=[set.capturedAt,set.completedAt,set.generatedAt,set.sourceFetchedAt,set.inputDecisionAt].filter(Boolean).map(millis);
  return times.length&&times.every(Number.isFinite)?Math.max(...times):null;
}
function cashFor(set) {
  const tickets=(set.plans||[]).filter(p=>p.status!=="unavailable");
  const noTicket=!tickets.length&&set.decisionSummary?.evaluated===true&&set.decisionSummary?.noBet===true;
  let stake=0,returned=0,won=0,settled=0,refunded=0,missing=0;
  for(const ticket of tickets){
    const cash=settledTicketCash(ticket);
    if(!cash){missing++;continue;}
    stake+=Number(cash.stake)/100;returned+=Number(cash.returned)/100;
    if(cash.outcome==="refund")refunded++;else {settled++;won+=Number(cash.outcome==="won");}
  }
  const complete=noTicket||tickets.length>0&&missing===0;
  return {tickets:tickets.length,noTicket,complete,won,settled,refunded,pending:missing,
    stake,returned,net:complete?returned-stake:null,roi:complete&&stake?returned/stake-1:null,hitRate:settled?won/settled:null};
}
const version=set=>`${set.decisionPolicy||"legacy"}|${set.baseModelVersion||"unknown-model"}|${set.calibrationVersion||"unknown-calibration"}`;
export function comparePurchaseSlots(input) {
  const merged=mergePurchaseBatches(input),days=new Map();
  for(const set of merged.planSets){if(!["17:00","21:00"].includes(set.scheduledTime))continue;
    days.set(set.date,[...(days.get(set.date)||[]),set]);}
  const rows=[...days].map(([date,sets])=>{
    const side=time=>{
      const candidates=sets.filter(s=>s.scheduledTime===time);
      const empty={snapshotId:null,actualAt:null,delaySeconds:null,timing:"unknown",version:null,verifiedVersion:false,manualException:false,cash:null,set:null};
      if(candidates.length!==1)return {...empty,status:candidates.length?"ambiguous":"missing",count:candidates.length};
      const set=candidates[0],at=batchInformationTime(set),target=millis(`${date}T${time}:00+08:00`);
      return {status:"observed",count:1,snapshotId:set.snapshotId,actualAt:at===null?null:new Date(at).toISOString(),
        delaySeconds:at===null?null:Math.max(0,(at-target)/1000),timing:at===null?"unknown":at<=target?"on-time":"delayed",
        version:version(set),verifiedVersion:Boolean(set.decisionPolicy&&set.baseModelVersion&&set.calibrationVersion),manualException:set.promotionKind==="manual-exception",cash:cashFor(set),set};
    };
    const early=side("17:00"),late=side("21:00");
    const paired=early.status==="observed"&&late.status==="observed"&&early.verifiedVersion&&late.verifiedVersion&&early.timing!=="unknown"&&late.timing!=="unknown"&&early.version===late.version&&early.cash.complete&&late.cash.complete&&!early.manualException&&!late.manualException;
    const timing=paired?early.timing==="on-time"&&late.timing==="on-time"?"strict":"delayed":"unpaired";
    const strategyPairs=paired?early.set.plans.flatMap(a=>{
      const b=late.set.plans.find(p=>p.id===a.id);
      const ac=settledTicketCash(a),bc=b&&settledTicketCash(b);
      return ac&&bc?[{definitionId:a.id,earlySnapshotId:early.snapshotId,lateSnapshotId:late.snapshotId,
        earlyNet:Number(ac.returned-ac.stake)/100,lateNet:Number(bc.returned-bc.stake)/100}]:[];
    }):[];
    return {date,early,late,paired,timing,strategyPairs,reason:paired?"":early.status!=="observed"||late.status!=="observed"?"缺少唯一的两侧批次":!early.verifiedVersion||!late.verifiedVersion?"历史版本证据不足，仅展示现金":early.timing==="unknown"||late.timing==="unknown"?"实际完成时间无法核验":early.version!==late.version?"模型/策略版本不同":early.manualException||late.manualException?"手动例外不进入严格配对":"尚有待结算或不完整记录"};
  }).sort((a,b)=>b.date.localeCompare(a.date));
  return {policy:"same-sales-day-policy-model-calibration-cash-v1",rows,conflicts:merged.conflicts,
    pairedDays:rows.filter(r=>r.paired).length,strictDays:rows.filter(r=>r.timing==="strict").length,delayedDays:rows.filter(r=>r.timing==="delayed").length,
    interpretation:"descriptive-cash-comparison-not-prediction-accuracy"};
}
