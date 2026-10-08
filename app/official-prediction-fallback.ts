/* eslint-disable @typescript-eslint/no-explicit-any */

const SCORE_LABELS=["1:0","2:0","2:1","3:0","3:1","3:2","4:0","4:1","4:2","5:0","5:1","5:2","胜其他","0:0","1:1","2:2","3:3","平其他","0:1","0:2","1:2","0:3","1:3","2:3","0:4","1:4","2:4","0:5","1:5","2:5","负其他"];
const TOTAL_LABELS=["0球","1球","2球","3球","4球","5球","6球","7+球"];
const HALF_FULL_LABELS=["胜胜","胜平","胜负","平胜","平平","平负","负胜","负平","负负"];

const finite=(value:unknown,fallback=0)=>Number.isFinite(Number(value))?Number(value):fallback;
const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value));
const marketOdds=(match:any,key:string)=>Array.isArray(match?.marketOdds?.[key])?match.marketOdds[key].map((value:unknown)=>finite(value)):[];
const deVig=(odds:number[])=>{const inverse=odds.map(value=>value>1?1/value:0),sum=inverse.reduce((total,value)=>total+value,0);return sum>0?inverse.map(value=>value/sum):[]};
const points=(labels:string[],probabilities:number[])=>labels.map((score,index)=>({score,probability:(probabilities[index]||0)*100})).filter(point=>point.probability>0);
const factorial=(value:number)=>{let result=1;for(let index=2;index<=value;index++)result*=index;return result};
const poisson=(lambda:number,value:number)=>Math.exp(-lambda)*lambda**value/factorial(value);
const hash=(value:string)=>{let result=2166136261;for(let index=0;index<value.length;index++){result^=value.charCodeAt(index);result=Math.imul(result,16777619)}return(result>>>0).toString(36)};

function poissonScores(home:number,away:number){
 const rows:{score:string;probability:number}[]=[];
 for(let h=0;h<=7;h++)for(let a=0;a<=7;a++)rows.push({score:`${h}:${a}`,probability:poisson(home,h)*poisson(away,a)*100});
 const sum=rows.reduce((total,row)=>total+row.probability,0)||1;
 return rows.map(row=>({...row,probability:row.probability/sum*100})).sort((left,right)=>right.probability-left.probability);
}

function expectedGoals(match:any,had:number[],total:number[]){
 const expectedTotal=total.length===8?total.reduce((sum,value,index)=>sum+value*(index===7?7.5:index),0):2.55;
 const homeShare=clamp(.5+((had[0]||0)-(had[2]||0))*.42,.2,.8);
 return{home:expectedTotal*homeShare,away:expectedTotal*(1-homeShare),total:expectedTotal};
}

export function buildOfficialPredictionFallback(matches:any[],generatedAt:string){
 const eligible=matches.filter(match=>deVig(marketOdds(match,"胜平负")).length===3);
 const fingerprint=eligible.map(match=>({id:match.officialMatchId||match.matchId||match.id,updatedAt:match.updatedAt,markets:match.marketOdds}));
 const digest=hash(JSON.stringify(fingerprint)),predictionId=`official-browser-${digest}`,inputSnapshotId=`official-five-market-${digest}`;
 const version={predictionId,inputSnapshotId,baseModelVersion:"official-five-market-browser-v1",calibrationVersion:"cal-none",generatedAt};
 const reports=eligible.map(match=>{
  const officialHad=marketOdds(match,"胜平负"),had=deVig(officialHad),officialHhad=marketOdds(match,"让球胜平负"),hhad=deVig(officialHhad),officialTtg=marketOdds(match,"总进球数"),ttg=deVig(officialTtg),officialHalfFull=marketOdds(match,"半全场"),halfFull=deVig(officialHalfFull),officialScores=marketOdds(match,"比分"),scoreProbabilities=deVig(officialScores);
  const xg=expectedGoals(match,had,ttg),fullScoreDistribution=scoreProbabilities.length===SCORE_LABELS.length?points(SCORE_LABELS,scoreProbabilities).sort((left,right)=>right.probability-left.probability):poissonScores(xg.home,xg.away),scores=fullScoreDistribution.slice(0,4);
  const hhadQualified=match.marketEligibility?.["让球胜平负"]?.qualification==="qualified"&&hhad.length===3&&String(match.handicap??"").trim()!=="",hhadProbabilities=hhadQualified?points(["让胜","让平","让负"],hhad):undefined,totalGoalProbabilities=ttg.length===8?points(TOTAL_LABELS,ttg):undefined,halfFullProbabilities=halfFull.length===9?points(HALF_FULL_LABELS,halfFull):undefined;
  const directionIndex=had.indexOf(Math.max(...had)),directions=["主队方向","平局方向","客队方向"],officialHandicap=hhadQualified?String(match.handicap):"",fairOdds=had.map(value=>value>0?1/value:0),overProbability=ttg.length===8?ttg.slice(3).reduce((sum,value)=>sum+value,0)*100:0;
  return{
   predictionId,inputSnapshotId,baseModelVersion:version.baseModelVersion,calibrationVersion:version.calibrationVersion,predictionGeneratedAt:generatedAt,
   id:match.id,officialMatchId:String(match.officialMatchId||match.matchId||""),salesDate:match.salesDate,kickoffAt:match.kickoffAt,homeTeamId:match.homeTeamId,awayTeamId:match.awayTeamId,homeTeamCode:match.homeTeamCode,awayTeamCode:match.awayTeamCode,officialMappingStatus:"verified",mappingReason:"体彩官方赛事直接匹配",marketEligibility:match.marketEligibility||{},league:match.league,time:match.matchDate&&match.time?`${match.matchDate} ${match.time}`:match.kickoffAt||match.time,matchDate:match.matchDate,home:match.home,away:match.away,matchStatus:match.matchStatus,isMock:false,sourceUpdatedAt:match.updatedAt||"",
   companies:[],marketProbabilities:had.map(value=>value*100),probabilities:{home:had[0]*100,draw:had[1]*100,away:had[2]*100},consensus:{handicap:finite(match.handicap),totalLine:xg.total,agreement:"官方基线"},
   marketSignal:{direction:directions[directionIndex],strength:Math.max(...had)*100,probabilityShifts:[0,0,0],fairOdds,hadEv:[0,0,0],hhadEv:hhadQualified?[0,0,0]:[],evThreshold:0,institutionAction:"外围赔率暂不可达",handicapExpectation:"当前仅使用体彩官方固定奖金与五玩法分布",firstHandicap:finite(match.handicap),handicapChange:0,narrative:"发布环境暂时无法读取外围赔率，当前为体彩官方五玩法去水概率基线；未使用示例赔率，也未把缺失盘口补成 0。",officialOdds:officialHad,officialHandicap,officialHhadOdds:hhadQualified?officialHhad:[],officialHhadFair:hhadQualified?hhad.map(value=>value*100):[],modeledHhad:hhadQualified?hhad.map(value=>value*100):[],hhadAvailable:hhadQualified,modeledTotalGoals:ttg.map(value=>value*100),totalGoalLabels:TOTAL_LABELS,modeledHalfFull:halfFull.map(value=>value*100),halfFullLabels:HALF_FULL_LABELS,asianHomeProbability:hhadQualified?(hhad[0]+hhad[1]*.5)*100:0,asianAwayProbability:hhadQualified?(hhad[2]+hhad[1]*.5)*100:0,asianMovement:0,overProbability,fitAgreement:"官方五玩法基线",handicapMeaning:officialHandicap?`体彩让球 ${officialHandicap}`:"体彩让球不可用",rawProbabilities:had.map(value=>value*100),calibrationSampleSize:0},
   expectedGoals:{home:xg.home,away:xg.away},scores,fullScoreDistribution,oddsScores:fullScoreDistribution,hadProbabilities:points(["胜","平","负"],had),hhadProbabilities,totalGoalProbabilities,halfFullProbabilities,missingCompanies:[1,2,3],intelligenceCoverage:0,appliedIntelligenceWeight:0,
  };
 });
 const unavailableMatches=matches.filter(match=>!reports.some(report=>report.officialMatchId===String(match.officialMatchId||match.matchId||""))).map(match=>({id:match.id,officialMatchId:match.officialMatchId||match.matchId,salesDate:match.salesDate,matchDate:match.matchDate,kickoffAt:match.kickoffAt,time:match.time,league:match.league,home:match.home,away:match.away,reason:"缺少可去水的体彩胜平负官方赔率"}));
 return{version,reports,unavailableMatches,coverage:{officialMatches:matches.length,predictedMatches:reports.length,unavailableMatches:unavailableMatches.length}};
}
