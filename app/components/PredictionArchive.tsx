"use client";

import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {readBrowserData,updateBrowserData} from "../browser-storage";
import {ModelCalibrationProfile,PREDICTION_RESULT_CACHE_STORAGE_KEY,PREDICTION_REVIEW_CACHE_STORAGE_KEY,PREDICTION_SNAPSHOT_STORAGE_KEY,SavedPredictionSet,ScorePoint} from "../prediction-config";
import {buildPostMatchReview,ImprovementArea,predictionScores,ReviewPrimary} from "../post-match-review";
import {buildModelEvaluation} from "../model-evaluation.js";
import ModelExperimentCenter from "./ModelExperimentCenter";

type Result={id:string;matchId?:string;date:string;home:string;away:string;fullScore:string;halfScore?:string;handicap:string;hhadResult?:string;scoreResult?:string;totalGoalsResult?:string};
type ResultCache=Record<string,Result>;
type ArchiveMatch=SavedPredictionSet["matches"][number] & {archiveEvidence?:"formal"|"browser_cache"|"purchase_plan_partial";archiveCapturedAt?:string;purchasePicks?:Array<{market:string;pick:string;probability:number}>};
type Snapshot=Omit<SavedPredictionSet,"matches"> & {matches:ArchiveMatch[];scheduleLabel:string;capturedAt?:string;storageOrigin?:"server"|"local"|"migrated-browser"|"recovered"};
type SavedMatch=Snapshot["matches"][number];
type AiReview={key:string;primary:string;summary:string;causeTags:string[];improvements:string[];evidenceLevel:string;predictability:string;provider:string;generatedAt:string};
type AiReviewCache=Record<string,AiReview>;
type ArchiveAnalysisView="review"|"score"|"had"|"hhad"|"total"|"half-full";
type EvaluatedRow={match:SavedMatch;result:Result};
type AccuracyValue={hits:number;total:number};
type AccuracyMetricKey="scoreTop1"|"scoreTop3"|"had"|"hhad"|"totalTop1"|"totalTop2"|"halfFull"|"halfFullTop2";

const dateOptionLabel=(date:string)=>new Date(`${date}T00:00:00+08:00`).toLocaleDateString("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit",weekday:"short"});
const shanghaiToday=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const normalizeName=(value:string)=>String(value||"").replace(/[\s·.·（）()]/g,"");
const parseDate=(value:string,fallback:string)=>{
 const source=String(value||"");
 const full=source.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
 if(full)return `${full[1]}-${full[2].padStart(2,"0")}-${full[3].padStart(2,"0")}`;
 const short=source.match(/(?:^|\D)(\d{1,2})[-/](\d{1,2})(?:\D|$)/);
 return short&&/^\d{4}-\d{2}-\d{2}$/.test(fallback)?`${fallback.slice(0,4)}-${short[1].padStart(2,"0")}-${short[2].padStart(2,"0")}`:fallback;
};
const matchDate=(match:SavedMatch,snapshotDate:string)=>parseDate(match.matchDate||match.time||"",snapshotDate);
const kickoffTime=(match:SavedMatch)=>String(match.time||"").match(/(?:T|\s|^)(\d{1,2}:\d{2})(?::\d{2})?/)?.[1]||"—";
const hasMatchDate=(match:SavedMatch)=>/(\d{4})[-/]\d{1,2}[-/]\d{1,2}|(?:^|\D)\d{1,2}[-/]\d{1,2}(?:\D|$)/.test(String(match.matchDate||match.time||""));
const shiftDate=(date:string,offset:number)=>{
 const value=new Date(`${date}T12:00:00+08:00`);
 value.setUTCDate(value.getUTCDate()+offset);
 return value.toISOString().slice(0,10);
};
const candidateDates=(match:SavedMatch,snapshotDate:string)=>hasMatchDate(match)?[matchDate(match,snapshotDate)]:[-1,0,1].map(offset=>shiftDate(snapshotDate,offset));
const cacheKey=(match:SavedMatch,snapshotDate:string)=>match.officialMatchId?`official|${match.officialMatchId}`:`${matchDate(match,snapshotDate)}|${match.id}|${normalizeName(match.home)}|${normalizeName(match.away)}`;
const ranked=(points?:ScorePoint[])=>[...(points||[])].filter(point=>Boolean(String(point.score||"").trim())&&Number.isFinite(point.probability)).sort((a,b)=>b.probability-a.probability);
const first=(points?:ScorePoint[])=>ranked(points)[0];
const hadFromScores=(scores?:ScorePoint[])=>{
 const values=[0,0,0];ranked(scores).forEach(point=>{const [home,away]=point.score.split(":").map(Number);if(Number.isFinite(home)&&Number.isFinite(away))values[home>away?0:home===away?1:2]+=point.probability});
 const sum=values.reduce((total,value)=>total+value,0);return sum>0?["胜","平","负"].map((score,index)=>({score,probability:values[index]/sum*100})):[];
};
const leagueTone=(league?:string)=>Array.from(league||"其他联赛").reduce((sum,char)=>sum+char.charCodeAt(0),0)%12;
const ARCHIVE_TABS:Array<{key:ArchiveAnalysisView;label:string}>=[{key:"review",label:"综合回溯"},{key:"score",label:"比分预测"},{key:"had",label:"胜平负预测"},{key:"hhad",label:"让球预测"},{key:"total",label:"总进球数预测"},{key:"half-full",label:"半全场预测"}];
const outcome=(homeGoals:number,awayGoals:number)=>homeGoals>awayGoals?"胜":homeGoals===awayGoals?"平":"负";
const hhadOutcome=(homeGoals:number,awayGoals:number,handicap:string)=>{const adjusted=homeGoals-awayGoals+Number(handicap||0);return adjusted>0?"让胜":adjusted===0?"让平":"让负";};
const normalizeHhadOutcome=(value:string)=>{const result=String(value||"").replace(/\s+/g,"").match(/(?:让)?([胜平负])$/)?.[1];return result?`让${result}`:"";};
function PredictionTableCell({market,points,actual,actualValue,pending=false,candidates=1}:{market:"score"|"had"|"hhad"|"total"|"half-full";points?:ScorePoint[];actual?:string;actualValue?:string;pending?:boolean;candidates?:number}){
 const allPicks=ranked(points),picks=allPicks.slice(0,candidates),safeActual=String(actual||"").trim(),comparisonActual=String(actualValue??actual??"").trim(),normalizeTotal=(value:string)=>{const clean=value.replace("球","");const numeric=Number(clean);return Number.isFinite(numeric)&&numeric>=7?"7+":clean},normalize=(value:string)=>market==="total"?normalizeTotal(value):market==="hhad"?normalizeHhadOutcome(value):value,actualIndex=comparisonActual?allPicks.findIndex(point=>normalize(point.score)===normalize(comparisonActual)):-1;
 const strongReverse=!pending&&safeActual&&allPicks[0]?.probability>50&&((market==="had"&&((allPicks[0].score==="胜"&&comparisonActual==="负")||(allPicks[0].score==="负"&&comparisonActual==="胜")))||(market==="hhad"&&((normalizeHhadOutcome(allPicks[0].score)==="让胜"&&normalizeHhadOutcome(comparisonActual)==="让负")||(normalizeHhadOutcome(allPicks[0].score)==="让负"&&normalizeHhadOutcome(comparisonActual)==="让胜"))));
 const predictedGoal=market==="total"?Number(normalizeTotal(allPicks[0]?.score||"").replace("+","")):NaN,actualGoal=market==="total"?Number(normalizeTotal(comparisonActual).replace("+","")):NaN,totalDeviation=market==="total"&&actualIndex!==0&&actualIndex!==1&&Number.isFinite(predictedGoal)&&Number.isFinite(actualGoal)?actualGoal>predictedGoal?"大球偏离":"小球偏离":"";
 const secondaryEligible=(market==="score"||market==="total"||market==="half-full")&&actualIndex===1,backupEligible=market==="score"&&actualIndex===2;
 const status=pending?"待公布":!safeActual?"暂无数据":!picks.length?"暂无预测":strongReverse?"爆冷":actualIndex===0?"主选命中":secondaryEligible?"次选命中":backupEligible?"备选命中":totalDeviation||actualIndex>=0?totalDeviation||"候选未覆盖":"未命中";
 const tone=pending?"pending":!safeActual||!picks.length?"missing":actualIndex===0?"primary-hit":secondaryEligible?"secondary-hit":backupEligible?"backup-hit":"miss",rankLabels=market==="score"?["主选","次选","备选"]:market==="total"||market==="half-full"?["主选","次选"]:["主选"];
 return <div className={`prediction-table-result ${tone}`}><div className={`prediction-table-picks ${picks.length>1?"multiple":""}`}>{picks.length?picks.map((point,index)=><span className={`pick-rank pick-rank-${index+1}${actualIndex===index?" matched":""}`} key={`${point.score}-${index}`}><small>{rankLabels[index]||`第${index+1}顺位`}</small><strong>{point.score}</strong><em>{point.probability.toFixed(1)}%</em></span>):<strong className="prediction-empty">暂无预测</strong>}</div><div className="prediction-table-outcome"><strong>{pending?"待公布":safeActual||"暂无数据"}</strong><i className={`prediction-status ${tone}`}>{status}</i></div></div>;
}
function TicketEvidenceCell({match,market,actual}:{match:SavedMatch;market:string;actual?:string}){
 const picks=(match.purchasePicks||[]).filter(item=>item.market===market);
 return <div className="prediction-table-result missing"><div className="prediction-table-picks">{picks.length?<><small>17:00 票据选号</small><strong>{picks.map(item=>item.pick).join("；")}</strong></>:<strong className="prediction-empty">无该玩法留存</strong>}</div><div className="prediction-table-outcome"><strong>{actual||"待公布"}</strong><i className="prediction-status missing">非完整预测</i></div></div>;
}
function ReviewEvidencePopover({popoverId,evidenceLevel,predictability,improvements}:{popoverId:string;evidenceLevel:string;predictability:string;improvements:string[]}){
 const [open,setOpen]=useState(false),[position,setPosition]=useState({left:12,top:12,width:420});
 const triggerRef=useRef<HTMLButtonElement>(null),panelRef=useRef<HTMLElement>(null);
 const updatePosition=useCallback(()=>{const trigger=triggerRef.current;if(!trigger)return;const rect=trigger.getBoundingClientRect(),width=Math.min(420,window.innerWidth-24),left=Math.min(Math.max(12,rect.right-width),window.innerWidth-width-12),estimatedHeight=250,top=rect.bottom+8+estimatedHeight>window.innerHeight?Math.max(12,rect.top-estimatedHeight-8):rect.bottom+8;setPosition({left,top,width})},[]);
 useEffect(()=>{if(!open)return;updatePosition();const closeOnOutside=(event:MouseEvent)=>{const target=event.target as Node;if(!triggerRef.current?.contains(target)&&!panelRef.current?.contains(target))setOpen(false)},closeOnEscape=(event:KeyboardEvent)=>{if(event.key==="Escape")setOpen(false)};window.addEventListener("resize",updatePosition);window.addEventListener("scroll",updatePosition,true);document.addEventListener("mousedown",closeOnOutside);document.addEventListener("keydown",closeOnEscape);return()=>{window.removeEventListener("resize",updatePosition);window.removeEventListener("scroll",updatePosition,true);document.removeEventListener("mousedown",closeOnOutside);document.removeEventListener("keydown",closeOnEscape)}},[open,updatePosition]);
 return <><button ref={triggerRef} type="button" className="archive-evidence-trigger" aria-expanded={open} aria-controls={popoverId} onMouseEnter={()=>setOpen(true)} onClick={()=>setOpen(true)}>查看证据与模型改进</button>{open&&typeof document!=="undefined"&&createPortal(<aside ref={panelRef} id={popoverId} className="archive-evidence-popover" role="dialog" aria-label="证据与模型改进" style={position}><header><b>证据与模型改进</b><button type="button" aria-label="关闭悬浮窗" onClick={()=>setOpen(false)}>×</button></header><div><b>证据等级</b><span>{evidenceLevel}</span><b>赛前可预测性</b><span>{predictability}</span><b>建议补充</b><ul>{improvements.map(item=><li key={item}>{item}</li>)}</ul></div></aside>,document.body)}</>;
}
const halfFullActual=(result?:Result)=>{
 if(!result)return null;
 const [homeGoals,awayGoals]=String(result.fullScore||"").split(":").map(Number),[halfHome,halfAway]=String(result.halfScore||"").split(":").map(Number);
 if(![homeGoals,awayGoals,halfHome,halfAway].every(Number.isFinite))return null;
 return {label:`${outcome(halfHome,halfAway)}${outcome(homeGoals,awayGoals)}`,halfScore:`${halfHome}:${halfAway}`,fullScore:`${homeGoals}:${awayGoals}`};
};

const validFullScore=(result?:Result)=>{
 const goals=String(result?.fullScore||"").split(":").map(Number);
 return goals.length===2&&goals.every(Number.isFinite)?goals as [number,number]:null;
};
const accuracyText=(metric:AccuracyValue)=>metric.total?`${metric.hits}/${metric.total} · ${(metric.hits/metric.total*100).toFixed(1)}%`:"—";
const accuracyTone=(metric:AccuracyValue)=>!metric.total?"empty":metric.total<5?"small-sample":metric.hits/metric.total>=.6?"high":metric.hits/metric.total>=.4?"medium":"low";
const increment=(metric:AccuracyValue,hit:boolean)=>({hits:metric.hits+(hit?1:0),total:metric.total+1});

function LeagueAccuracyPanel({rows}:{rows:EvaluatedRow[]}){
 const [view,setView]=useState<ArchiveAnalysisView>("review"),[selectedLeague,setSelectedLeague]=useState("全部联赛"),[drilldown,setDrilldown]=useState<{league:string;key:AccuracyMetricKey}|null>(null);
 const metrics=Array.from(rows.reduce((groups,{match,result})=>{
  const full=validFullScore(result); if(!full)return groups;
  const league=match.league||"其他联赛",current=groups.get(league)||{league,matches:0,scoreTop1:{hits:0,total:0},scoreTop3:{hits:0,total:0},had:{hits:0,total:0},hhad:{hits:0,total:0},totalTop1:{hits:0,total:0},totalTop2:{hits:0,total:0},halfFull:{hits:0,total:0},halfFullTop2:{hits:0,total:0}};
  current.matches++;
  const actualScore=`${full[0]}:${full[1]}`,scores=predictionScores(match);
  if(scores.length){current.scoreTop1=increment(current.scoreTop1,scores[0]?.score===actualScore);current.scoreTop3=increment(current.scoreTop3,scores.slice(0,3).some(point=>point.score===actualScore));}
  const had=first(match.hadProbabilities); if(had)current.had=increment(current.had,had.score===outcome(full[0],full[1]));
  const hhad=first(match.hhadProbabilities); if(hhad)current.hhad=increment(current.hhad,hhad.score===hhadOutcome(full[0],full[1],match.handicap||result.handicap));
  const totals=ranked(match.totalGoalProbabilities); if(totals.length){const actual=full[0]+full[1]>=7?"7+":String(full[0]+full[1]);current.totalTop1=increment(current.totalTop1,totals[0]?.score.replace("球","")===actual);current.totalTop2=increment(current.totalTop2,totals.slice(0,2).some(point=>point.score.replace("球","")===actual));}
  const halfPredictions=ranked(match.halfFullProbabilities),half=halfPredictions[0],actualHalf=halfFullActual(result); if(half&&actualHalf){current.halfFull=increment(current.halfFull,half.score===actualHalf.label);current.halfFullTop2=increment(current.halfFullTop2,halfPredictions.slice(0,2).some(point=>point.score===actualHalf.label));}
  groups.set(league,current);return groups;
 },new Map<string,{league:string;matches:number;scoreTop1:AccuracyValue;scoreTop3:AccuracyValue;had:AccuracyValue;hhad:AccuracyValue;totalTop1:AccuracyValue;totalTop2:AccuracyValue;halfFull:AccuracyValue;halfFullTop2:AccuracyValue}>()).values()).sort((a,b)=>b.matches-a.matches||a.league.localeCompare(b.league,"zh-CN"));
 const columns:AccuracyMetricKey[]=view==="score"?["scoreTop1","scoreTop3"]:view==="had"?["had"]:view==="hhad"?["hhad"]:view==="total"?["totalTop1","totalTop2"]:view==="half-full"?["halfFull","halfFullTop2"]:["scoreTop1","scoreTop3","had","hhad","totalTop1","totalTop2","halfFull","halfFullTop2"];
 const labels:Record<AccuracyMetricKey,string>={scoreTop1:"比分首选",scoreTop3:"比分前三",had:"胜平负",hhad:"让球",totalTop1:"总进球首选",totalTop2:"总进球前二",halfFull:"半全场首选",halfFullTop2:"半全场前二"};
 const validMatchCount=metrics.reduce((sum,item)=>sum+item.matches,0);
 const leagues=["全部联赛",...metrics.map(item=>item.league)],displayMetrics=selectedLeague==="全部联赛"?metrics:metrics.filter(item=>item.league===selectedLeague);
 const detailRows=drilldown?rows.flatMap(({match,result})=>{
  if((match.league||"其他联赛")!==drilldown.league)return[];
  const full=validFullScore(result);if(!full)return[];
  let points:ScorePoint[]=[],actual="",limit=1;
  if(drilldown.key==="scoreTop1"||drilldown.key==="scoreTop3"){points=predictionScores(match);actual=`${full[0]}:${full[1]}`;limit=drilldown.key==="scoreTop3"?3:1;}
  else if(drilldown.key==="had"){points=ranked(match.hadProbabilities);actual=outcome(full[0],full[1]);}
  else if(drilldown.key==="hhad"){points=ranked(match.hhadProbabilities);actual=hhadOutcome(full[0],full[1],match.handicap||result.handicap);}
  else if(drilldown.key==="totalTop1"||drilldown.key==="totalTop2"){points=ranked(match.totalGoalProbabilities);actual=full[0]+full[1]>=7?"7+":String(full[0]+full[1]);limit=drilldown.key==="totalTop2"?2:1;}
  else{points=ranked(match.halfFullProbabilities);actual=halfFullActual(result)?.label||"";limit=drilldown.key==="halfFullTop2"?2:1;}
  const normalize=(value:string)=>drilldown.key.startsWith("total")?value.replace("球",""):drilldown.key==="hhad"?normalizeHhadOutcome(value):value,shown=points.slice(0,limit),hit=Boolean(actual&&shown.some(point=>normalize(point.score)===normalize(actual)));
  return points.length&&actual?[{match,result,points:shown,actual,hit}]:[];
 }):[];
 return <section className="league-accuracy-panel" aria-label="按联赛评估预测正确率"><details><summary><div><small>全部已结算历史 · 按比赛去重</small><h3>各联赛预测正确率</h3></div><span>{metrics.length} 个联赛 · {validMatchCount} 场 <b className="collapse-copy"/></span></summary><div className="collapsible-panel-body">
  <div className="accuracy-panel-toolbar"><div className="archive-view-tabs" role="tablist" aria-label="联赛正确率预测类型">{ARCHIVE_TABS.map(tab=><button key={tab.key} type="button" role="tab" aria-selected={view===tab.key} className={view===tab.key?"active":""} onClick={()=>{setView(tab.key);setDrilldown(null)}}>{tab.label}</button>)}</div><label>按联赛筛选<select aria-label="正确率联赛筛选" value={selectedLeague} onChange={event=>{setSelectedLeague(event.target.value);setDrilldown(null)}}>{leagues.map(league=><option key={league}>{league}</option>)}</select></label></div>
  <div className="league-accuracy-wrap"><table className="league-accuracy-table"><thead><tr><th>联赛</th><th>样本</th>{columns.map(key=><th key={key}>{labels[key]}</th>)}</tr></thead><tbody>{displayMetrics.map(item=><tr key={item.league}><td><b>{item.league}</b></td><td>{item.matches} 场{item.matches<5&&<em>小样本</em>}</td>{columns.map(key=><td key={key}><button type="button" aria-expanded={drilldown?.league===item.league&&drilldown.key===key} className={`accuracy-rate ${accuracyTone(item[key])}`} onClick={()=>setDrilldown(current=>current?.league===item.league&&current.key===key?null:{league:item.league,key})}>{accuracyText(item[key])}</button></td>)}</tr>)}</tbody></table></div>
  {drilldown&&<section className="accuracy-drilldown" aria-label={`${drilldown.league}${labels[drilldown.key]}明细`}><header><div><small>预测与实际结果明细</small><h4>{drilldown.league} · {labels[drilldown.key]}</h4></div><button type="button" onClick={()=>setDrilldown(null)}>收起明细</button></header><div className="league-accuracy-wrap"><table><thead><tr><th>比赛日/场次</th><th>对阵</th><th>赛前预测</th><th>实际结果</th><th>核验</th></tr></thead><tbody>{detailRows.map(({match,result,points,actual,hit})=><tr key={`${result.date}-${match.officialMatchId||match.id}`}><td><small>{result.date}</small><b>{match.id}</b></td><td>{match.home} <i>VS</i> {match.away}</td><td><div className="accuracy-detail-picks">{points.map((point,index)=><span className={`pick-rank-${index+1}`} key={`${point.score}-${index}`}><b>{point.score}</b><em>{point.probability.toFixed(1)}%</em></span>)}</div></td><td><strong>{actual}</strong></td><td><span className={`accuracy-detail-status ${hit?"hit":"miss"}`}>{hit?"命中":"未命中"}</span></td></tr>)}</tbody></table></div></section>}
  <p>正确率分母只包含“已有真实赛果且该预测字段完整”的比赛；同一比赛的多个快照只取最近一次，少于 5 场仅供观察。</p>
 </div></details></section>;
}

function FocusedPredictionView({rows,view,loading,snapshotDate}:{rows:Array<{match:SavedMatch;result?:Result}>;view:Exclude<ArchiveAnalysisView,"review"|"half-full">;loading:boolean;snapshotDate:string}){
 const label={score:"比分预测",had:"胜平负预测",hhad:"让球预测",total:"总进球数预测"}[view];
 return <div className="focused-archive-view" role="tabpanel" aria-label={label}><p className="archive-source-note">仅核验当前快照保存时的原始预测，不会用赛果反向改写预测。未保存对应预测字段的旧快照显示为“无预测”。</p><div className="archive-table-wrap"><table className="archive-table focused-archive-table"><thead><tr><th>场次</th><th>比赛日</th><th>联赛</th><th>对阵</th><th>赛前预测</th>{view==="hhad"&&<th>竞彩让球</th>}<th>实际赛果</th><th>验证结果</th></tr></thead><tbody>{rows.map(({match,result})=>{
  const full=validFullScore(result),actualScore=full?`${full[0]}:${full[1]}`:"",points=view==="score"?predictionScores(match):view==="had"?ranked(match.hadProbabilities):view==="hhad"?ranked(match.hhadProbabilities):ranked(match.totalGoalProbabilities);
  const actual=!full?"":view==="score"?actualScore:view==="had"?outcome(full[0],full[1]):view==="hhad"?hhadOutcome(full[0],full[1],match.handicap||result?.handicap||""):full[0]+full[1]>=7?"7+":String(full[0]+full[1]);
  const normalized=(value:string)=>view==="total"?value.replace("球",""):value,actualIndex=actual?points.findIndex(point=>normalized(point.score)===actual):-1,secondaryHit=(view==="total"||view==="score")&&actualIndex===1,backupHit=view==="score"&&actualIndex===2,status=!result?"赛果待公布":!points.length?"无预测":actualIndex===0?"主选命中":secondaryHit?"次选命中":backupHit?"备选命中":"未命中",tone=actualIndex===0?"primary":secondaryHit?"secondary":backupHit?"backup":result&&points.length?"miss":"pending",pickCount=view==="score"?3:view==="total"?2:1,rankLabels=view==="score"?["主选","次选","备选"]:view==="total"?["主选","次选"]:["主选"];
  return <tr key={`${match.id}-${match.time}`}><td><b>{match.id}</b></td><td>{result?.date||matchDate(match,snapshotDate)||"—"}</td><td><span className="focused-league">{match.league}</span></td><td><div className="half-full-versus"><strong>{match.home}</strong><span>VS</span><strong>{match.away}</strong></div></td><td><div className="focused-picks">{points.slice(0,pickCount).map((point,index)=><span className={`pick-rank-${index+1}${actualIndex===index?" matched":""}`} key={`${point.score}-${index}`}><small>{rankLabels[index]}</small><b>{point.score}</b><em>{point.probability.toFixed(1)}%</em></span>)}{!points.length&&"—"}</div></td>{view==="hhad"&&<td><b>{match.handicap||result?.handicap||"—"}</b></td>}<td><strong className="focused-actual">{actual||"—"}</strong></td><td><span className={`half-full-status ${tone}`}>{loading&&!result?"读取中":status}</span></td></tr>;
 })}</tbody></table></div></div>;
}

function HalfFullPredictionView({rows,loading,snapshotDate}:{rows:Array<{match:SavedMatch;result?:Result}>;loading:boolean;snapshotDate:string}){
 const evaluated=rows.map(row=>({row,actual:halfFullActual(row.result),predictions:ranked(row.match.halfFullProbabilities).slice(0,2)}));
 const comparable=evaluated.filter(item=>item.actual&&item.predictions.length),topHits=comparable.filter(item=>item.predictions[0]?.score===item.actual?.label).length,topTwoHits=comparable.filter(item=>item.predictions.slice(0,2).some(point=>point.score===item.actual?.label)).length;
 const metric=(value:number)=>comparable.length?`${value}/${comparable.length} · ${(value/comparable.length*100).toFixed(1)}%`:"暂无可核验样本";
 return <div className="half-full-archive-view" role="tabpanel" aria-label="半全场预测">
  <div className="half-full-metrics"><div><small>可核验样本</small><b>{comparable.length} 场</b></div><div className="primary"><small>主选命中</small><b>{metric(topHits)}</b></div><div><small>主选 + 次选命中</small><b>{metric(topTwoHits)}</b></div><div><small>缺少半全场预测</small><b>{rows.filter(row=>!row.match.halfFullProbabilities?.length).length} 场</b></div></div>
  <p className="archive-source-note">半全场只使用快照保存时的原始概率排序；“胜平”表示半场主胜、全场平局。已公布半场与全场比分后自动核验，旧快照没有该字段时不会补造预测。</p>
  <div className="archive-table-wrap"><table className="archive-table half-full-archive-table"><thead><tr><th>场次</th><th>比赛日</th><th>对阵</th><th>主选</th><th>次选</th><th>半场比分</th><th>全场比分</th><th>实际半全场</th><th>验证结果</th></tr></thead><tbody>{evaluated.map(({row,actual,predictions})=>{
   const actualIndex=actual?predictions.findIndex(point=>point.score===actual.label):-1,status=!row.result?"赛果待公布":!actual?"半场赛果待接入":!predictions.length?"旧快照无预测":actualIndex===0?"主选命中":actualIndex===1?"次选命中":"未覆盖",tone=actualIndex===0?"primary":actualIndex===1?"secondary":actual?"miss":"pending";
   return <tr key={`${row.match.id}-${row.match.time}`}><td><b>{row.match.id}</b></td><td>{row.result?.date||matchDate(row.match,snapshotDate)||"—"}</td><td><div className="half-full-versus"><strong>{row.match.home}</strong><span>VS</span><strong>{row.match.away}</strong></div></td>{[0,1].map(index=><td key={index}>{predictions[index]?<span className={`half-full-pick pick-rank-${index+1}${actualIndex===index?" matched":""}`}><small>{index===0?"主选":"次选"}</small><b>{predictions[index].score}</b><em>{predictions[index].probability.toFixed(1)}%</em></span>:<span className="muted">—</span>}</td>)}<td>{actual?.halfScore||"—"}</td><td>{actual?.fullScore||"—"}</td><td>{actual?<b className="half-full-actual">{actual.label}</b>:"—"}</td><td><span className={`half-full-status ${tone}`}>{loading&&!row.result?"读取中":status}</span></td></tr>;
  })}</tbody></table></div>
 </div>;
}
const readSnapshots=async():Promise<Snapshot[]>=>{
 if(typeof window==="undefined")return [];
 try{const stored=await readBrowserData<Snapshot[]>(PREDICTION_SNAPSHOT_STORAGE_KEY,[]);return sortSnapshots((Array.isArray(stored)?stored:[]).map(item=>({...item,storageOrigin:item.storageOrigin==="server"?"server":"local",scheduleLabel:item.storageOrigin==="server"?String(item.scheduleLabel||"").replace("工作日09:45","工作日21:45"):"页面缓存（非定时快照）"})));}catch{return []}
};
const snapshotKey=(snapshot:Snapshot)=>`${snapshot.date}|${snapshot.sourceFetchedAt}|${snapshot.predictionId||"legacy"}`;
const reviewCacheKey=(snapshot:Snapshot,match:SavedMatch)=>`${snapshotKey(snapshot)}|${match.id}|${normalizeName(match.home)}|${normalizeName(match.away)}`;
const sortSnapshots=(items:Snapshot[])=>[...items].sort((left,right)=>String(right.capturedAt||right.sourceFetchedAt).localeCompare(String(left.capturedAt||left.sourceFetchedAt)));
const mergeSnapshots=(existing:Snapshot[],incoming:Snapshot[])=>sortSnapshots(Array.from(new Map([...existing,...incoming].map(snapshot=>[snapshotKey(snapshot),snapshot])).values()));
const readResultCache=async():Promise<ResultCache>=>{
 if(typeof window==="undefined")return {};
 const cached=await readBrowserData<ResultCache>(PREDICTION_RESULT_CACHE_STORAGE_KEY,{});return cached&&typeof cached==="object"&&!Array.isArray(cached)?cached:{};
};
// 新版优先使用官方比赛 ID；旧快照才回退到“比赛日 + 竞彩编号”，避免跨日同编号串场。
const sameMatch=(result:Result,match:SavedMatch,date:string)=>match.officialMatchId&&result.matchId?String(result.matchId)===String(match.officialMatchId):result.id===match.id&&result.date===date;
const IMPROVEMENT_ACTIONS:Record<ImprovementArea,string>={"赛前情报覆盖":"补充首发、伤停、轮换与封盘前变化","比分分布校准":"用历史方差修正独立泊松的窄尾问题","让球分布校准":"统一比分分布与体彩固定让球归并","总进球校准":"用历史进球均值弱校准大小球锚点","半全场状态转移":"按实际半场进球占比调整上下半场强度","历史快照完整性":"后续快照强制保存五类完整原始概率","赛中事件数据":"预留红牌、点球、射正与xG时间线证据"};

export default function PredictionArchive(){
 const [snapshots,setSnapshots]=useState<Snapshot[]>([]);
 const [selectedDate,setSelectedDate]=useState("");
 const [selectedKey,setSelectedKey]=useState("");
 const [resultCache,setResultCache]=useState<ResultCache>({});
 const [loading,setLoading]=useState(false);
 const [leagueFilter,setLeagueFilter]=useState("全部联赛");
 const [query,setQuery]=useState("");
 const [archiveView,setArchiveView]=useState<ArchiveAnalysisView>("review");
 const reviewProvider="deepseek";
 const [aiReviewCache,setAiReviewCache]=useState<AiReviewCache>({});
 const [aiReviewLoading,setAiReviewLoading]=useState(false);
 const [aiReviewError,setAiReviewError]=useState("");
 const [resultSyncError,setResultSyncError]=useState("");
 const [calibrationProfile,setCalibrationProfile]=useState<ModelCalibrationProfile|null>(null);
 const snapshotDates=useMemo(()=>Array.from(new Set(snapshots.map(snapshot=>snapshot.date))).sort((left,right)=>right.localeCompare(left)),[snapshots]);
 const effectiveSelectedDate=snapshotDates.includes(selectedDate)?selectedDate:snapshotDates[0]||"";
 const dateSnapshots=useMemo(()=>snapshots.filter(snapshot=>snapshot.date===effectiveSelectedDate),[snapshots,effectiveSelectedDate]);
 const selected=dateSnapshots.find(snapshot=>snapshotKey(snapshot)===selectedKey)||dateSnapshots.find(snapshot=>snapshot.storageOrigin==="recovered")||dateSnapshots[0];
 const resultFor=useCallback((match:SavedMatch)=>selected?resultCache[cacheKey(match,selected.date)]:undefined,[resultCache,selected]);
 const pendingEntries=useMemo(()=>snapshots.filter(snapshot=>snapshot.storageOrigin!=="recovered").flatMap(snapshot=>snapshot.matches.filter(match=>candidateDates(match,snapshot.date).some(day=>day<=shanghaiToday())&&!resultCache[cacheKey(match,snapshot.date)]).map(match=>({snapshot,match}))),[snapshots,resultCache]);

 useEffect(()=>{
  let active=true;
  const remoteArchive=fetch("/api/prediction-snapshots",{cache:"no-store"}).then(async response=>{
   const data=await response.json();
   return response.ok?{snapshots:Array.isArray(data.snapshots)?data.snapshots as Snapshot[]:[],resultCache:data.resultCache&&typeof data.resultCache==="object"&&!Array.isArray(data.resultCache)?data.resultCache as ResultCache:{},resultCorrections:data.resultCorrections&&typeof data.resultCorrections==="object"&&!Array.isArray(data.resultCorrections)?data.resultCorrections as ResultCache:{}}:{snapshots:[] as Snapshot[],resultCache:{} as ResultCache,resultCorrections:{} as ResultCache};
  }).catch(()=>({snapshots:[] as Snapshot[],resultCache:{} as ResultCache,resultCorrections:{} as ResultCache}));
  void Promise.all([readSnapshots(),readResultCache(),readBrowserData<AiReviewCache>(PREDICTION_REVIEW_CACHE_STORAGE_KEY,{}),remoteArchive]).then(([localSnapshots,localResults,localReviews,remote])=>{
   if(!active)return;
   setSnapshots(mergeSnapshots(localSnapshots,remote.snapshots));setResultCache({...remote.resultCache,...localResults,...remote.resultCorrections});setAiReviewCache(localReviews&&typeof localReviews==="object"&&!Array.isArray(localReviews)?localReviews:{});
  });
  return()=>{active=false};
 },[]);

 useEffect(()=>{
  if(!pendingEntries.length)return;
  let active=true;
  const pendingByDate=new Map<string,SavedMatch[]>();
  pendingEntries.forEach(({snapshot,match})=>candidateDates(match,snapshot.date).filter(day=>day<=shanghaiToday()).forEach(day=>pendingByDate.set(day,[...(pendingByDate.get(day)||[]),match])));
  queueMicrotask(()=>{if(active){setLoading(true);setResultSyncError("");}});
  Promise.all(Array.from(pendingByDate.keys()).map(async day=>{
   const response=await fetch(`/api/sporttery/results?date=${day}`,{cache:"no-store"});
   const data=await response.json();
   if(!response.ok)throw new Error(data.error||`${day} 赛果读取失败`);
   return (data.results||[]) as Result[];
  })).then(groups=>{
   if(!active)return;
   const fetched=groups.flat();
   const additions:ResultCache={};
   pendingEntries.forEach(({snapshot,match})=>{
    const result=fetched.find(item=>candidateDates(match,snapshot.date).some(day=>sameMatch(item,match,day)));
    if(result)additions[cacheKey(match,snapshot.date)]=result;
   });
   if(Object.keys(additions).length){
    setResultCache(current=>({...current,...additions}));
    void updateBrowserData<ResultCache>(PREDICTION_RESULT_CACHE_STORAGE_KEY,{},current=>({...current,...additions}));
   }
  }).catch(error=>{if(active)setResultSyncError(error instanceof Error?error.message:"赛果同步失败");}).finally(()=>{if(active)setLoading(false)});
  return()=>{active=false};
 },[pendingEntries]);

 const stats=useMemo(()=>{
  if(!selected)return null;
  let total=0,score=0,backup=0,upset=0,had=0,hhad=0,goalPrimary=0,goalCovered=0,halfFull=0,halfFullCovered=0,goalTotal=0,halfFullTotal=0;
  selected.matches.filter(match=>selected.storageOrigin!=="recovered"||match.archiveEvidence==="formal").forEach(match=>{
   const result=resultFor(match); if(!result)return;
   total++;
   const [homeGoals,awayGoals]=result.fullScore.split(":").map(Number),actual=outcome(homeGoals,awayGoals);
   const scores=predictionScores(match),actualScore=`${homeGoals}:${awayGoals}`;
   if(scores[0]?.score===actualScore)score++;else if(scores[1]?.score===actualScore)backup++;else if(scores[2]?.score===actualScore)upset++;
   if(first(match.hadProbabilities)?.score===actual)had++;
   if(first(match.hhadProbabilities)?.score===hhadOutcome(homeGoals,awayGoals,match.handicap||result.handicap))hhad++;
   const goalsLabel=homeGoals+awayGoals>=7?"7+":String(homeGoals+awayGoals);
   const goalForecasts=ranked(match.totalGoalProbabilities).slice(0,2);
   if(goalForecasts.length){goalTotal++;if(goalForecasts[0]?.score.replace("球","")===goalsLabel)goalPrimary++;if(goalForecasts.some(point=>point.score.replace("球","")===goalsLabel))goalCovered++;}
   const [halfHome,halfAway]=String(result.halfScore||"").split(":").map(Number);
   const halfFullForecasts=ranked(match.halfFullProbabilities).slice(0,2),actualHalfFull=`${outcome(halfHome,halfAway)}${actual}`;
   if(Number.isFinite(halfHome)&&Number.isFinite(halfAway)&&halfFullForecasts.length){halfFullTotal++;if(halfFullForecasts[0]?.score===actualHalfFull)halfFull++;if(halfFullForecasts.some(point=>point.score===actualHalfFull))halfFullCovered++;}
  });
 return {total,score,backup,upset,had,hhad,goalPrimary,goalCovered,halfFull,halfFullCovered,goalTotal,halfFullTotal};
 },[selected,resultFor]);

 const snapshotAudit=useMemo(()=>{
  const today=shanghaiToday(),sourceSnapshots=snapshots.filter(snapshot=>snapshot.storageOrigin!=="recovered"),scheduled=sourceSnapshots.filter(snapshot=>snapshot.storageOrigin==="server").length,migrated=sourceSnapshots.filter(snapshot=>snapshot.storageOrigin==="migrated-browser").length,local=sourceSnapshots.length-scheduled-migrated;
  const eligible=sourceSnapshots.flatMap(snapshot=>snapshot.matches.filter(match=>Boolean(resultCache[cacheKey(match,snapshot.date)])||matchDate(match,snapshot.date)<today).map(match=>({snapshot,match})));
  const settled=eligible.filter(({snapshot,match})=>Boolean(resultCache[cacheKey(match,snapshot.date)])).length;
  const completeForecasts=eligible.filter(({match})=>Boolean(match.hadProbabilities?.length&&match.hhadProbabilities?.length&&predictionScores(match).length&&match.totalGoalProbabilities?.length&&match.halfFullProbabilities?.length)).length;
  return {total:sourceSnapshots.length,scheduled,migrated,local,eligible:eligible.length,settled,completeForecasts};
 },[snapshots,resultCache]);

 const allReviewedRows=useMemo(()=>snapshots.filter(snapshot=>snapshot.storageOrigin!=="recovered").flatMap(snapshot=>snapshot.matches.flatMap(match=>{const result=resultCache[cacheKey(match,snapshot.date)];return result?[{snapshot,match,result,review:buildPostMatchReview(match,result)}]:[]})),[snapshots,resultCache]);
 const modelEvaluation=useMemo(()=>buildModelEvaluation(allReviewedRows.map(({snapshot,match,result})=>({
  key:`${match.salesDate||snapshot.date}|${match.officialMatchId||`${result.date}|${result.id}|${normalizeName(match.home)}|${normalizeName(match.away)}`}`,
  salesDate:match.salesDate||snapshot.date,kickoffAt:match.kickoffAt||"",capturedAt:snapshot.capturedAt||snapshot.sourceFetchedAt,
  id:match.id,officialMatchId:match.officialMatchId||"",league:match.league,home:match.home,away:match.away,completeness:match.completeness,intelligenceCoverage:match.intelligenceCoverage||0,
  modelHad:match.hadProbabilities||[],challengerHad:match.shadowHadProbabilities||[],marketHad:match.marketHadProbabilities||[],scoreDistribution:predictionScores(match),totalGoalProbabilities:match.totalGoalProbabilities||[],hhadProbabilities:match.hhadProbabilities||[],halfFullProbabilities:match.halfFullProbabilities||[],handicap:match.handicap||result.handicap||"0",fullScore:result.fullScore,halfScore:result.halfScore||""
 }))),[allReviewedRows]);
 const leagueEvaluationRows=useMemo(()=>{
  const unique=new Map<string,EvaluatedRow>();
  allReviewedRows.forEach(({match,result})=>{const key=match.officialMatchId||`${result.date}|${result.id}`;if(!unique.has(key))unique.set(key,{match,result});});
  return Array.from(unique.values());
 },[allReviewedRows]);
 useEffect(()=>{
  let active=true;const observations=allReviewedRows.flatMap(({snapshot,match,result})=>{const full=validFullScore(result),half=String(result.halfScore||"").split(":").map(Number),kickoffAt=match.kickoffAt||"",capturedAt=snapshot.capturedAt||snapshot.sourceFetchedAt,market=match.marketHadProbabilities||[],baseModel=hadFromScores(match.oddsScores);if(!full||match.hadProbabilities?.length!==3||market.length!==3||!kickoffAt||!capturedAt)return[];return[{matchKey:`${match.salesDate||snapshot.date}|${match.officialMatchId||`${result.date}|${result.id}`}`,league:match.league,kickoffAt,capturedAt,modelProbabilities:match.hadProbabilities,baseModelProbabilities:baseModel.length===3?baseModel:undefined,intelligenceCandidateProbabilities:match.shadowHadProbabilities?.length===3?match.shadowHadProbabilities:undefined,marketProbabilities:market,actual:outcome(full[0],full[1]),totalGoals:full[0]+full[1],halfGoals:half.length===2&&half.every(Number.isFinite)?half[0]+half[1]:undefined,homeGoals:full[0],awayGoals:full[1],expectedHomeGoals:match.expectedGoals?.home,expectedAwayGoals:match.expectedGoals?.away,intelligenceCoverage:match.intelligenceCoverage||0}]});
  fetch("/api/calibration",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({observations})}).then(response=>response.json()).then(data=>{if(active)setCalibrationProfile(data.evaluation||data.published||null)}).catch(()=>fetch("/api/calibration",{cache:"no-store"}).then(response=>response.json()).then(data=>{if(active)setCalibrationProfile(data.profile||null)}).catch(()=>{}));return()=>{active=false};
 },[allReviewedRows]);
 const improvementSummary=useMemo(()=>{
  const counts=new Map<ImprovementArea,number>();
  allReviewedRows.forEach(({review})=>review.improvementAreas.forEach(area=>counts.set(area,(counts.get(area)||0)+1)));
  return Array.from(counts.entries()).map(([area,count])=>{
   const denominator=area==="总进球校准"?allReviewedRows.filter(({match})=>Boolean(match.totalGoalProbabilities?.length)).length:area==="半全场状态转移"?allReviewedRows.filter(({match})=>Boolean(match.halfFullProbabilities?.length)).length:allReviewedRows.length;
   return{area,count,denominator,rate:denominator?count/denominator*100:0,action:IMPROVEMENT_ACTIONS[area]};
  }).sort((left,right)=>right.rate-left.rate||right.count-left.count);
 },[allReviewedRows]);

 const reviewedRows=useMemo(()=>!selected?[]:selected.matches.map(match=>{const result=resultFor(match);return{match,result,review:result&&match.archiveEvidence!=="purchase_plan_partial"?buildPostMatchReview(match,result):undefined}}),[selected,resultFor]);
 const reviewMetrics=useMemo(()=>{
  const completed=reviewedRows.filter(row=>row.review),count=(label:ReviewPrimary)=>completed.filter(row=>row.review?.primary===label).length;
  return{total:completed.length,normal:count("正常兑现"),deviation:count("合理偏差"),upset:count("爆冷"),insufficient:count("数据不足"),averageProbability:completed.length?completed.reduce((sum,row)=>sum+(row.review?.actualOutcomeProbability||0),0)/completed.length:0,brier:completed.length?completed.reduce((sum,row)=>sum+(row.review?.brierScore||0),0)/completed.length:0};
 },[reviewedRows]);
 const leagues=useMemo(()=>["全部联赛",...Array.from(new Set((selected?.matches||[]).map(match=>match.league).filter(Boolean)))],[selected]);
 const baseVisibleRows=reviewedRows.filter(({match})=>(leagueFilter==="全部联赛"||match.league===leagueFilter)&&`${match.id} ${match.home} ${match.away}`.toLowerCase().includes(query.trim().toLowerCase()));
 const visibleRows=baseVisibleRows;

 async function runAiPostMatchReview(){
  if(!selected)return;
  const candidates=reviewedRows.filter(row=>row.result&&row.review);
  if(!candidates.length)return;
  setAiReviewLoading(true);setAiReviewError("");
  try{
   const items=candidates.map(({match,result,review})=>({key:reviewCacheKey(selected,match),match:{id:match.id,league:match.league,home:match.home,away:match.away},prediction:{scores:predictionScores(match).slice(0,3),had:match.hadProbabilities,hhad:match.hhadProbabilities,totalGoals:match.totalGoalProbabilities,halfFull:match.halfFullProbabilities,handicap:match.handicap,confidence:match.confidence,completeness:match.completeness},result,quantitativeReview:review,preMatchAi:{summary:match.aiSummary||"",risk:match.aiRisk||""}}));
   const response=await fetch(`/api/predictions/post-match-review?provider=${reviewProvider}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({items})}),data=await response.json();
   if(!response.ok)throw new Error(data.error||"AI盘后复盘失败");
   const additions:AiReviewCache={};
   (Array.isArray(data.reviews)?data.reviews:[]).forEach((review:Omit<AiReview,"provider"|"generatedAt">)=>{if(review.key)additions[review.key]={...review,provider:String(data.provider||"AI"),generatedAt:String(data.generatedAt||new Date().toISOString())};});
   setAiReviewCache(current=>({...current,...additions}));
   void updateBrowserData<AiReviewCache>(PREDICTION_REVIEW_CACHE_STORAGE_KEY,{},current=>({...current,...additions}));
  }catch(error){setAiReviewError(error instanceof Error?error.message:"AI盘后复盘失败");}finally{setAiReviewLoading(false);}
 }

 return <section className="archive-page">
 <div className="section-head archive-page-head"><div><p className="eyebrow">PREDICTION ARCHIVE</p><h2>盘后预测回溯</h2><p>每个彩票日合并为一页；每场采用最接近且不晚于规定决策时点的赛前快照。</p></div><div className="archive-head-filters"><label className="archive-date-select"><span>选择彩票日期</span><select aria-label="盘后回溯彩票日期" value={effectiveSelectedDate} onChange={event=>{setSelectedDate(event.target.value);setSelectedKey("")}} disabled={!snapshotDates.length}>{snapshotDates.map(date=><option key={date} value={date}>{dateOptionLabel(date)}</option>)}</select></label></div></div>
 {selected?.storageOrigin==="recovered"?<div className="prediction-disclaimer"><b>赛前留存补齐视图</b><span>{selected.scheduleLabel}。页面缓存不是规定时点快照；9 月 24 日仅有组合票选号，缺少完整预测概率，不计入本页命中率。</span></div>:selected?.predictionId&&<div className="prediction-disclaimer"><b>预测版本 {selected.predictionId}</b><span>复盘统计使用该快照保存的原始概率，不重新计算。</span></div>}
 <div className="archive-data-audit" aria-label="快照数据检查"><div><small>已读取快照</small><b>{snapshotAudit.total} 个</b></div><div className={snapshotAudit.scheduled?"verified":"audit-warning"}><small>定时文件快照</small><b>{snapshotAudit.scheduled} 个</b></div><div className={snapshotAudit.local?"audit-warning":"verified"}><small>已迁移 / 仅本机</small><b>{snapshotAudit.migrated} / {snapshotAudit.local} 个</b></div><div className={snapshotAudit.settled===snapshotAudit.eligible&&snapshotAudit.eligible?"verified":"audit-warning"}><small>历史赛果覆盖</small><b>{snapshotAudit.settled}/{snapshotAudit.eligible}</b></div><div className={snapshotAudit.completeForecasts===snapshotAudit.eligible&&snapshotAudit.eligible?"verified":"audit-warning"}><small>完整预测字段</small><b>{snapshotAudit.completeForecasts}/{snapshotAudit.eligible}</b></div></div>
 {improvementSummary.length>0&&<section className="model-improvement-panel"><header><div><small>全部已结算快照</small><h3>模型改进方向汇总</h3></div>{calibrationProfile&&<div className="calibration-badges"><span>固定决策样本 {calibrationProfile.forecastSampleSize}/{calibrationProfile.uniqueMatchCount}</span><span>覆盖率 {((calibrationProfile.coverage||0)*100).toFixed(1)}%</span><span>训练/校准/测试 {calibrationProfile.trainingSampleSize||0}/{calibrationProfile.calibrationSampleSize||0}/{calibrationProfile.testSampleSize||0}</span><span>滚动验证 {calibrationProfile.rollingValidation?.folds||0} 折/{calibrationProfile.rollingValidation?.sampleSize||0} 场</span><span>概率温度 {calibrationProfile.probabilityTemperature.toFixed(2)}</span><span>{calibrationProfile.status==="validated"?`正式版本 ${calibrationProfile.profileId}`:"样本不足·未发布"}</span></div>}</header>{calibrationProfile&&<div className="calibration-validation-grid"><article><small>校准拟合成绩</small><b>Brier {calibrationProfile.fitting?.raw.brier.toFixed(3)??"—"} → {calibrationProfile.fitting?.calibrated.brier.toFixed(3)??"—"}</b><span>Log Loss {calibrationProfile.fitting?.raw.logLoss.toFixed(3)??"—"} → {calibrationProfile.fitting?.calibrated.logLoss.toFixed(3)??"—"}</span><em>仅说明参数对校准区间的拟合，不作为未来改进证据。</em></article><article><small>未参与调参的未来测试成绩</small><b>模型 Brier {calibrationProfile.futureTest?.calibrated.brier.toFixed(3)??"—"}</b><span>市场基线 {calibrationProfile.futureTest?.marketBaseline.brier.toFixed(3)??"—"} · 样本 {calibrationProfile.futureTest?.calibrated.sampleSize||0}</span><em>测试赛果不参与温度和模型参数选择。</em></article><article><small>滚动时间验证</small><b>模型 Brier {calibrationProfile.rollingValidation?.calibrated.brier.toFixed(3)??"—"}</b><span>市场基线 {calibrationProfile.rollingValidation?.marketBaseline.brier.toFixed(3)??"—"}</span><em>每折只用此前校准窗选参数，再评估随后比赛。</em></article><article><small>模拟收益</small><b>暂不计算</b><span>缺少逐方案完整成本或决策时固定赔率</span><em>不会用赛后价格或挑选赢家补算收益。</em></article></div>}{calibrationProfile?.futureTest&&<details className="calibration-buckets"><summary>查看未来测试概率分桶校准</summary><table><thead><tr><th>概率区间</th><th>样本点</th><th>模型均值</th><th>实际频率</th></tr></thead><tbody>{calibrationProfile.futureTest.calibrated.buckets.map(bucket=><tr key={bucket.range}><td>{bucket.range}</td><td>{bucket.count}</td><td>{(bucket.meanProbability*100).toFixed(1)}%</td><td>{(bucket.observedRate*100).toFixed(1)}%</td></tr>)}</tbody></table></details>}<div className="model-improvement-grid">{improvementSummary.map(item=><article key={item.area}><div><b>{item.area}</b><strong>{item.count}/{item.denominator} · {item.rate.toFixed(1)}%</strong></div><p>{item.action}</p></article>)}</div><p className="model-improvement-note">同一比赛按正式决策时点取最近且不晚于该时点的快照；随后按比赛时间执行60%训练、20%校准、20%未来测试，并开展多折滚动时间验证。正式预测只读取服务端已发布版本，浏览器统计不会直接改变模型参数。</p></section>}
 {modelEvaluation.sampleSize>0&&<ModelExperimentCenter report={modelEvaluation}/>}
 {resultSyncError&&<div className="data-fallback">赛果补抓未完成：{resultSyncError}。未取得赛果的场次会在下次打开页面时继续查询。</div>}
  {!selected?<div className="results-empty">尚无符合正式决策时点规则的赛前快照。</div>:<>
   <LeagueAccuracyPanel rows={leagueEvaluationRows}/>
   <section className="archive-match-workspace" aria-label="场次复盘摘要工作区"><header className="archive-block-heading"><div><small>当前快照 · 独立分析区</small><h3>场次复盘摘要</h3></div><span>{reviewedRows.length} 场</span></header>
   <div className="archive-stats">{[["比分主选",stats?.score,stats?.total],["比分次选",stats?.backup,stats?.total],["比分备选",stats?.upset,stats?.total],["胜平负",stats?.had,stats?.total],["让胜平负",stats?.hhad,stats?.total],["总进球主选",stats?.goalPrimary,stats?.goalTotal],["总进球主选+次选",stats?.goalCovered,stats?.goalTotal],["半全场主选",stats?.halfFull,stats?.halfFullTotal],["半全场主选+次选",stats?.halfFullCovered,stats?.halfFullTotal]].map(([label,value,denominator])=><div key={String(label)}><small>{label}</small><b>{Number(denominator)>0?`${value}/${denominator} · ${(Number(value)/Number(denominator)*100).toFixed(1)}%`:"暂无预测样本"}</b></div>)}</div>
   <section className="archive-analysis-toolbar" aria-label="场次复盘分析选项与筛选"><div className="archive-view-tabs" role="tablist" aria-label="场次复盘预测类型">{ARCHIVE_TABS.map(tab=><button key={tab.key} type="button" role="tab" aria-selected={archiveView===tab.key} className={archiveView===tab.key?"active":""} onClick={()=>setArchiveView(tab.key)}>{tab.label}</button>)}</div><div className="archive-review-filters"><label>按联赛筛选<select value={leagueFilter} onChange={event=>setLeagueFilter(event.target.value)}>{leagues.map(league=><option key={league}>{league}</option>)}</select></label><label className="archive-review-search">搜索<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="场次或球队"/></label>{archiveView==="review"&&<><label>深度复盘模型<select value="deepseek" disabled><option value="deepseek">DeepSeek</option></select></label><button className="archive-ai-review-button" disabled={!reviewMetrics.total||aiReviewLoading} onClick={runAiPostMatchReview}>{aiReviewLoading?"AI复盘中…":"生成AI深度复盘"}</button></>}<small>显示 {archiveView==="review"?visibleRows.length:baseVisibleRows.length} / {reviewedRows.length} 场</small></div></section>
   {archiveView==="review"?<><div className="review-overview"><div><small>已完成复盘</small><b>{reviewMetrics.total} 场</b></div><div className="normal"><small>正常兑现</small><b>{reviewMetrics.normal} 场</b></div><div className="deviation"><small>合理偏差</small><b>{reviewMetrics.deviation} 场</b></div><div className="upset"><small>爆冷</small><b>{reviewMetrics.upset} 场</b></div><div className="insufficient"><small>数据不足</small><b>{reviewMetrics.insufficient} 场</b></div><div><small>平均实际赛果概率</small><b>{reviewMetrics.total?`${reviewMetrics.averageProbability.toFixed(1)}%`:"—"}</b></div><div><small>多分类 Brier ↓</small><b>{reviewMetrics.total?reviewMetrics.brier.toFixed(3):"—"}</b></div></div>
   {aiReviewError&&<div className="data-fallback">AI深度复盘未完成：{aiReviewError}。规则复盘仍可正常使用。</div>}
   <p className="archive-source-note">已同步的赛果不再请求网络；仅“未公布”场次按实际比赛日向足彩网重新查询。复盘主标签按赛前原始概率计算；Brier 越低越好。当前未接入赛中事件时间线，红牌、点球等只能标记“待核验”，不会由系统臆测。</p>
   <details className="archive-match-review" open><summary><div><small>当前快照</small><b>场次复盘摘要</b></div><span>{visibleRows.length} 场 <b className="collapse-copy"/></span></summary><div className="archive-table-wrap"><table className="archive-table archive-review-table"><thead><tr><th>场次<br/>比赛时间</th><th>对阵</th><th>比分</th><th>胜平负</th><th>让球胜平负</th><th>总进球</th><th>半全场</th><th>复盘摘要</th></tr></thead><tbody>{visibleRows.map(({match,result,review})=>{
    const scores=predictionScores(match),aiReview=aiReviewCache[reviewCacheKey(selected,match)],summary=aiReview?.summary||review?.summary,improvements=aiReview?.improvements?.length?aiReview.improvements:review?.improvements||[],fullGoals=validFullScore(result),actualHad=fullGoals?outcome(fullGoals[0],fullGoals[1]):undefined,actualHhad=fullGoals?(normalizeHhadOutcome(result?.hhadResult||"")||hhadOutcome(fullGoals[0],fullGoals[1],match.handicap||result?.handicap||"")):undefined,actualHhadLabel=actualHhad?.replace(/^让/,""),actualGoals=fullGoals?String(fullGoals[0]+fullGoals[1]):undefined,actualHalfFull=halfFullActual(result)?.label;
    return <tr key={`${match.id}-${match.time}`}>
     <td className="archive-match-meta" data-label="场次 / 时间"><b>{match.id}</b><em className="archive-match-league" data-tone={leagueTone(match.league)}>{match.league||"其他联赛"}</em><span>{result?.date||matchDate(match,selected.date)||"—"}</span><strong>{kickoffTime(match)}</strong>{selected.storageOrigin==="recovered"&&<small>{match.archiveEvidence==="formal"?"正式快照":match.archiveEvidence==="browser_cache"?"赛前页面缓存":"17:00 组合票留存"}</small>}</td>
     <td className="archive-versus" data-label="对阵"><strong>{match.home}</strong><i>VS</i><strong>{match.away}</strong></td>
     <td data-label="比分">{match.archiveEvidence==="purchase_plan_partial"?<TicketEvidenceCell match={match} market="score" actual={result?.fullScore}/>:<PredictionTableCell market="score" points={scores} actual={result?.fullScore} pending={!result} candidates={3}/>}</td>
     <td data-label="胜平负">{match.archiveEvidence==="purchase_plan_partial"?<TicketEvidenceCell match={match} market="had" actual={actualHad}/>:<PredictionTableCell market="had" points={match.hadProbabilities} actual={actualHad} pending={!result}/>}</td>
     <td data-label="让球胜平负">{match.archiveEvidence==="purchase_plan_partial"?<TicketEvidenceCell match={match} market="hhad" actual={actualHhad}/>:<PredictionTableCell market="hhad" points={match.hhadProbabilities} actual={actualHhad?`${match.handicap||result?.handicap?`(${match.handicap||result?.handicap}) `:""}${actualHhadLabel}`:undefined} actualValue={actualHhad} pending={!result}/>}</td>
     <td data-label="总进球">{match.archiveEvidence==="purchase_plan_partial"?<TicketEvidenceCell match={match} market="total" actual={actualGoals?`${actualGoals}球`:undefined}/>:<PredictionTableCell market="total" points={match.totalGoalProbabilities} actual={actualGoals?`${actualGoals}球`:undefined} actualValue={actualGoals} pending={!result} candidates={2}/>}</td>
     <td data-label="半全场">{match.archiveEvidence==="purchase_plan_partial"?<TicketEvidenceCell match={match} market="halfFull" actual={actualHalfFull}/>:<PredictionTableCell market="half-full" points={match.halfFullProbabilities} actual={actualHalfFull} pending={!result} candidates={2}/>}</td>
     <td className="archive-review-summary" data-label="复盘摘要">{match.archiveEvidence==="purchase_plan_partial"?<p>仅存有 17:00 组合票中的选号与对应赛前赔率；完整比分分布及五种玩法概率未保存，不能计算模型命中率。{result?`实际比分 ${result.fullScore}。`:"赛果待补。"}</p>:review?<><p>{match.archiveEvidence==="browser_cache"?"赛前页面缓存，非规定时点的正式快照。":""}{summary}</p>{aiReview&&<small className="archive-ai-review-meta">{aiReview.provider} 深度复盘 · {new Date(aiReview.generatedAt).toLocaleString("zh-CN")}</small>}<ReviewEvidencePopover popoverId={`review-evidence-${selected.date}-${match.id}`.replace(/[^a-zA-Z0-9_-]/g,"-")} evidenceLevel={aiReview?.evidenceLevel||review.evidenceLevel} predictability={aiReview?.predictability||review.predictability} improvements={improvements}/></>:"赛果公布后自动生成结构化复盘"}</td>
    </tr>;
   })}</tbody></table></div></details></>:archiveView==="half-full"?<HalfFullPredictionView rows={baseVisibleRows} loading={loading} snapshotDate={selected.date}/>:<FocusedPredictionView rows={baseVisibleRows} view={archiveView} loading={loading} snapshotDate={selected.date}/>}</section>
  </>}
 </section>;
}
