// AI reuses a signed frozen context. It never fetches later evidence or trusts
// a browser's claim that its payload was verified.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const bytes=value=>new TextEncoder().encode(JSON.stringify(canonical(value)));
const hex=buffer=>Array.from(new Uint8Array(buffer),v=>v.toString(16).padStart(2,"0")).join("");
const digest=async value=>hex(await crypto.subtle.digest("SHA-256",bytes(value)));
const identity=report=>({predictionId:report.predictionId,officialMatchId:report.officialMatchId,home:report.home,away:report.away,kickoffAt:report.kickoffAt,inputSnapshotId:report.inputSnapshotId});
const key=secret=>crypto.subtle.importKey("raw",new TextEncoder().encode("football-context-proof-v1\0"+secret),{name:"HMAC",hash:"SHA-256"},false,["sign","verify"]);
export async function signContextProof(report,secret){
 const context=report.modelInput?.matchContext;
 if(!secret||!context||context.status==="unavailable"||report.officialMappingStatus!=="verified")return null;
 const payload={...identity(report),contextHash:await digest(context),version:1};
 return {...payload,signature:hex(await crypto.subtle.sign("HMAC",await key(secret),bytes(payload)))};
}
export async function resolveContextEvidence(report,secret,reviewAt=new Date().toISOString()){
 const empty={status:"unverified",evidence:[],conflicts:[],unknowns:["原预测没有可验证的赛前资料，请刷新预测后复核","非点球xG与射门质量","球员替补影响"],independentSourceGroups:0};
 const proof=report.contextProof,context=report.modelInput?.matchContext;
 if(!secret||!proof||!context||!/^\d+$/.test(String(report.officialMatchId||""))||!/^[0-9a-f]{64}$/.test(proof.signature||""))return empty;
 const payload={...identity(report),contextHash:await digest(context),version:1};
 const signature=Uint8Array.from(proof.signature.match(/../g),pair=>parseInt(pair,16));
 if(!await crypto.subtle.verify("HMAC",await key(secret),signature,bytes(payload)))return empty;
 const review=Date.parse(reviewAt),kickoff=Date.parse(report.kickoffAt),observed=Date.parse(context.observedAt);
 if(!Number.isFinite(review)||!Number.isFinite(kickoff)||!Number.isFinite(observed)||observed>review||observed>=kickoff||review-observed>48*3600000)return empty;
 const evidence=[];
 const add=(kind,value,summary,sourceUrl,observedAt,classification="fundamental")=>{
  const at=Date.parse(observedAt);
  if(!/^https:\/\//.test(sourceUrl||"")||!Number.isFinite(at)||at>review||at>=kickoff)return;
  evidence.push({evidenceId:`e${evidence.length+1}`,kind,classification,sourceGroup:"official-sporttery",sourceUrl,observedAt,summary,value});
 };
 const recent=context.fixtures||[];
 if(recent.length)add("recent-results",{recent:context.recent,fixtures:recent},`已核验近期赛果${recent.length}场；休息日仅按日历日期估计`,recent[0].sourceUrl,recent[0].observedAt);
 for(const injury of context.injuries||[])add("injury-record",injury,`${injury.side==="home"?"主队":"客队"} ${injury.player}：${Number(injury.injuryFlag)===1?"伤病":"停赛"}记录，替补影响未量化`,injury.sourceUrl,injury.observedAt);
 const schedule=context.schedule||[];
 if(schedule.length)add("upcoming-schedule",schedule,`已核验后续赛程${schedule.length}场；轮换意图未知`,schedule[0].sourceUrl,schedule[0].observedAt);
 if(context.lineup)add("source-starters",context.lineup,"来源确认的赛前首发，主客队各11人",context.lineup.sourceUrl,context.lineup.observedAt);
 const timeline=context.oddsTimeline||[];
 if(timeline.length)add("odds-timeline",timeline,`带时间的官方盘口观测${timeline.length}条，属于市场信息`,timeline[0].sourceUrl,timeline[0].observedAt,"market-observation");
 const conflicts=[];
 const lineup=evidence.find(row=>row.kind==="source-starters");
 for(const injury of evidence.filter(row=>row.kind==="injury-record"))if(lineup&&(lineup.value[injury.value.side]||[]).some(player=>player.personId===injury.value.personId))conflicts.push({conflictId:`c${conflicts.length+1}`,text:"伤停记录与首发列表出现同一球员，需确认资料更新时序",evidenceIds:[injury.evidenceId,lineup.evidenceId]});
 return {status:"verified-frozen-context",contextObservedAt:context.observedAt,evidence,conflicts,unknowns:context.missing||[],independentSourceGroups:new Set(evidence.filter(r=>r.classification==="fundamental").map(r=>r.sourceGroup)).size};
}
export function validateEvidenceReviews(reviews,inputs){
 if(!Array.isArray(reviews)||reviews.length!==inputs.length||new Set(reviews.map(r=>String(r.id))).size!==inputs.length)throw new Error("AI返回场次不完整或重复");
 return inputs.map(input=>{
  const review=reviews.find(row=>String(row.id)===String(input.id));
  if(!review)throw new Error("AI返回了不属于本批次的场次");
  const byId=new Map(input.context.evidence.map(row=>[row.evidenceId,row]));
  const clean=(rows,verifiedFacts=false)=>{
   if(!Array.isArray(rows)||rows.length>20)throw new Error("AI证据摘要结构无效");
   return rows.map(row=>{
    if(typeof row.text!=="string"||row.text.length>2000||!Array.isArray(row.evidenceIds)||!row.evidenceIds.length||row.evidenceIds.some(id=>!byId.has(id)))throw new Error("AI引用了未经核验的资料");
    const evidenceIds=[...new Set(row.evidenceIds)];
    const checkLabels={"recent-results":"核验近期对手强弱及主客场差异","injury-record":"核验球员出场状态及替补影响","upcoming-schedule":"核验赛程密度与轮换安排","source-starters":"核验首发来源及发布时间","odds-timeline":"核验报价时间和市场分歧"};
    return {text:evidenceIds.map(id=>verifiedFacts?byId.get(id).summary:checkLabels[byId.get(id).kind]).join("；"),evidenceIds,sources:evidenceIds.map(id=>{const {value,...source}=byId.get(id);return source;})};
   });
  };
  if(!Array.isArray(review.conflicts)||review.conflicts.some(row=>!input.context.conflicts.some(conflict=>conflict.conflictId===row.conflictId)))throw new Error("AI引用了未经核验的冲突");
  const conflicts=review.conflicts.map(row=>{const conflict=input.context.conflicts.find(item=>item.conflictId===row.conflictId);return {...conflict,sources:conflict.evidenceIds.map(id=>{const {value,...source}=byId.get(id);return source;})};});
  return {id:input.id,facts:clean(review.facts,true),conflicts,checks:clean(review.checks),unknowns:input.context.unknowns,contextStatus:input.context.status,independentSourceGroups:input.context.independentSourceGroups};
 });
}
export function applyEvidenceReviews(baseVersion,reports,reviews,provider,model,generatedAt){
 const aiReviewVersion=`${provider}:${model}:evidence-summary-v1:${generatedAt}`;
 return {version:{...baseVersion,aiReviewVersion,aiReviewedAt:generatedAt,reviewForPredictionId:baseVersion.predictionId,reviewMode:"evidence-summary-v1"},reports:reports.map(report=>{
  const review=reviews.find(row=>String(row.id)===String(report.id));
  return {...report,aiEvidenceSummary:review,aiSummary:[...review.facts.map(row=>row.text),...review.conflicts.map(row=>"需复核的冲突："+row.text),...review.checks.map(row=>"检查项："+row.text)].join("；")||"没有可验证的新增赛前资料",aiRisk:review.unknowns.join("；"),aiReviewMode:"evidence-summary-v1",aiReviewedAt:generatedAt};
 })};
}
