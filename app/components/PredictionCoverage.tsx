import {predictionKickoffParts} from "../prediction-config";

export type PredictionCoverageSummary={officialMatches:number;predictedMatches:number;unavailableMatches:number;pendingExternalMappings?:number};
export type UnavailablePredictionMatch={id:string;officialMatchId?:string;salesDate?:string;kickoffAt?:string;matchDate?:string;time?:string;league?:string;home:string;away:string;reason:string;externalCandidates?:Array<{externalId?:string;displayId?:string;league?:string;externalTime?:string;canConfirmNameMatch?:boolean;home?:string;away?:string;matchDate?:string;time?:string}>};

export default function PredictionCoverage({coverage,unavailableMatches=[],predictedCount,onRetry,retrying=false,retryMessage=""}:{coverage?:PredictionCoverageSummary|null;unavailableMatches?:UnavailablePredictionMatch[];predictedCount:number;onRetry?:(confirmedOfficialMatchId?:string)=>void;retrying?:boolean;retryMessage?:string}){
 function confirmMatch(match:UnavailablePredictionMatch,candidate:NonNullable<UnavailablePredictionMatch["externalCandidates"]>[number]){
  if(!window.confirm(`请确认主客方向一致且是同一场比赛：\n官方：${match.home} VS ${match.away}\n外围：${candidate.home} VS ${candidate.away}\n${match.league} · ${match.kickoffAt}\n此确认仅保存在当前浏览器，有效24小时；不会修改全局别名或后台采集规则。`))return;
  try{
   const key="ff-manual-fixture-mappings",stored=JSON.parse(localStorage.getItem(key)||"[]");
   const records=Array.isArray(stored)?stored.filter(record=>record.officialMatchId!==match.officialMatchId&&Date.now()-Date.parse(record.confirmedAt)<24*3600000):[];
   const record={officialMatchId:match.officialMatchId,salesDate:match.salesDate,kickoffAt:match.kickoffAt,home:match.home,away:match.away,league:match.league,externalId:candidate.externalId,externalHome:candidate.home,externalAway:candidate.away,externalTime:candidate.externalTime,externalLeague:candidate.league,confirmedAt:new Date().toISOString()};
   localStorage.setItem(key,JSON.stringify([...records.slice(-119),record]));
   onRetry?.(match.officialMatchId);
  }catch{window.alert("人工确认保存失败，未跳过名称验证。请检查浏览器存储权限。");}
 }
 if(!coverage)return null;
 return <section className="prediction-coverage" aria-label="比赛预测覆盖情况">
  <header><strong>已生成 {predictedCount} / {coverage.officialMatches} 场预测</strong><div className="prediction-coverage-actions"><span>{unavailableMatches.length?`${unavailableMatches.length} 场待核验 / 数据不足` : "全部场次已覆盖"}</span>{unavailableMatches.length>0&&onRetry&&<button type="button" onClick={()=>onRetry()} disabled={retrying}>{retrying?"正在抓取并核验…":"重新抓取并核验"}</button>}</div></header>
  {retryMessage&&<p className={/(失败|未完成)/.test(retryMessage)?"prediction-retry-message failed":"prediction-retry-message"}>{retryMessage}</p>}
  {unavailableMatches.length>0&&<>
   <p>以下比赛暂不生成概率，待数据核验通过后纳入预测。</p>
   <ul>{unavailableMatches.map(match=><li className={onRetry&&match.externalCandidates?.some(candidate=>candidate.canConfirmNameMatch&&candidate.displayId===match.id)?"has-confirm-action":undefined} key={`${match.officialMatchId||match.id}-${match.salesDate||""}`}>
    <div><b>{match.id}</b>{match.league&&<span>{match.league}</span>}<time>{predictionKickoffParts(match).label}</time></div>
    <strong>{match.home} <i>VS</i> {match.away}</strong><div className="prediction-mapping-reason"><p>{match.reason}</p>{match.externalCandidates?.length?<small>外围返回：{match.externalCandidates.map(candidate=>`${candidate.home||"—"} VS ${candidate.away||"—"}`).join("；")}</small>:null}</div>
    {onRetry&&match.externalCandidates?.filter(candidate=>candidate.canConfirmNameMatch&&candidate.displayId===match.id).map(candidate=><button className="prediction-confirm-match" key={candidate.externalId} type="button" disabled={retrying} onClick={()=>confirmMatch(match,candidate)} title="仅确认队名对应，其他数据仍须通过校验">确认同场并执行AI预测</button>)}
   </li>)}</ul>
  </>}
 </section>;
}
