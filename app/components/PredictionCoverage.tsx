import {predictionKickoffParts} from "../prediction-config";

export type PredictionCoverageSummary={officialMatches:number;predictedMatches:number;unavailableMatches:number;pendingExternalMappings?:number};
export type UnavailablePredictionMatch={id:string;officialMatchId?:string;salesDate?:string;kickoffAt?:string;matchDate?:string;time?:string;league?:string;home:string;away:string;reason:string};

export default function PredictionCoverage({coverage,unavailableMatches=[],predictedCount,onRetry,retrying=false,retryMessage=""}:{coverage?:PredictionCoverageSummary|null;unavailableMatches?:UnavailablePredictionMatch[];predictedCount:number;onRetry?:()=>void;retrying?:boolean;retryMessage?:string}){
 if(!coverage)return null;
 return <section className="prediction-coverage" aria-label="比赛预测覆盖情况">
  <header><strong>已生成 {predictedCount} / {coverage.officialMatches} 场预测</strong><div className="prediction-coverage-actions"><span>{unavailableMatches.length?`${unavailableMatches.length} 场待核验 / 数据不足` : "全部场次已覆盖"}</span>{unavailableMatches.length>0&&onRetry&&<button type="button" onClick={onRetry} disabled={retrying}>{retrying?"正在抓取并核验…":"重新抓取并核验"}</button>}</div></header>
  {retryMessage&&<p className={retryMessage.startsWith("补抓失败")?"prediction-retry-message failed":"prediction-retry-message"}>{retryMessage}</p>}
  {unavailableMatches.length>0&&<>
   <p>以下比赛暂不生成概率，待数据核验通过后纳入预测。</p>
   <ul>{unavailableMatches.map(match=><li key={`${match.officialMatchId||match.id}-${match.salesDate||""}`}>
    <div><b>{match.id}</b>{match.league&&<span>{match.league}</span>}<time>{predictionKickoffParts(match).label}</time></div>
    <strong>{match.home} <i>VS</i> {match.away}</strong><p>{match.reason}</p>
   </li>)}</ul>
  </>}
 </section>;
}
