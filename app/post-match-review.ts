import type {SavedPrediction,ScorePoint} from "./prediction-config";

export type ReviewPrimary="正常兑现"|"合理偏差"|"爆冷"|"数据不足";
export type ReviewPredictability="高"|"中"|"低";
export type ImprovementArea="赛前情报覆盖"|"比分分布校准"|"让球分布校准"|"总进球校准"|"半全场状态转移"|"历史快照完整性"|"赛中事件数据";
export type ReviewResult={
 primary:ReviewPrimary;causeTags:string[];evidenceLevel:string;predictability:ReviewPredictability;
 summary:string;improvements:string[];improvementAreas:ImprovementArea[];actualOutcomeProbability:number;brierScore:number;
 outcomeMatched:boolean;hhadMatched:boolean;scoreRank:number;totalMatched:boolean;totalGoalRank:number;totalTopTwoMatched:boolean;halfFullMatched:boolean;
};
export type SettledReviewInput={fullScore:string;halfScore?:string;handicap:string;};

export const REVIEW_THRESHOLDS={upsetProbability:20,upsetGap:15,largeGoalDeviation:2} as const;
const ranked=(points?:ScorePoint[])=>[...(points||[])].filter(point=>Number.isFinite(point.probability)).sort((a,b)=>b.probability-a.probability);
const outcome=(home:number,away:number)=>home>away?"胜":home===away?"平":"负";
const normalizeGoalLabel=(value:string)=>value.replace("球","");
const isOppositeResult=(forecast:string,actual:string,homeLabel:string,awayLabel:string)=>(forecast===homeLabel&&actual===awayLabel)||(forecast===awayLabel&&actual===homeLabel);

export function predictionScores(match:SavedPrediction){
 return ranked(match.combinedScores?.length?match.combinedScores:match.intelligenceScores?.length?match.intelligenceScores:match.oddsScores);
}

export function buildPostMatchReview(match:SavedPrediction,result:SettledReviewInput):ReviewResult{
 const [homeGoals,awayGoals]=String(result.fullScore||"").split(":").map(Number);
 const [halfHome,halfAway]=String(result.halfScore||"").split(":").map(Number);
 const had=ranked(match.hadProbabilities),scores=predictionScores(match),goals=ranked(match.totalGoalProbabilities),halfFull=ranked(match.halfFullProbabilities);
 if(!Number.isFinite(homeGoals)||!Number.isFinite(awayGoals)||!had.length){return{primary:"数据不足",causeTags:["数据不足"],evidenceLevel:"无法核验",predictability:"低",summary:"缺少有效赛果或赛前概率，当前不能进行可靠复盘。",improvements:["检查比赛匹配、快照字段与赛果来源。"],improvementAreas:["历史快照完整性"],actualOutcomeProbability:0,brierScore:0,outcomeMatched:false,hhadMatched:false,scoreRank:0,totalMatched:false,totalGoalRank:0,totalTopTwoMatched:false,halfFullMatched:false};}
 const actualOutcome=outcome(homeGoals,awayGoals),forecastOutcome=had[0],actualPoint=had.find(point=>point.score===actualOutcome),actualProbability=actualPoint?.probability||0;
 const outcomeMatched=forecastOutcome.score===actualOutcome,actualRank=Math.max(1,had.findIndex(point=>point.score===actualOutcome)+1),leadGap=forecastOutcome.probability-actualProbability;
 const actualScore=`${homeGoals}:${awayGoals}`,scoreRank=scores.findIndex(point=>point.score===actualScore)+1;
 const predictedGoalPoint=goals[0],actualGoals=homeGoals+awayGoals,actualGoalLabel=actualGoals>=7?"7+":String(actualGoals),predictedGoals=predictedGoalPoint?normalizeGoalLabel(predictedGoalPoint.score):"";
 const actualGoalRank=goals.findIndex(point=>normalizeGoalLabel(point.score)===actualGoalLabel)+1,totalMatched=actualGoalRank===1,totalReasonableDeviation=actualGoalRank===2,totalTopTwoMatched=totalMatched||totalReasonableDeviation,totalOutsideTopTwo=Boolean(predictedGoalPoint&&!totalTopTwoMatched);
 const actualHalfFull=Number.isFinite(halfHome)&&Number.isFinite(halfAway)?`${outcome(halfHome,halfAway)}${actualOutcome}`:"";
 const halfFullMatched=Boolean(actualHalfFull&&halfFull[0]?.score===actualHalfFull);
 const hhad=ranked(match.hhadProbabilities),actualHhad=outcome(homeGoals+Number(match.handicap||result.handicap||0),awayGoals),hhadLabel=`让${actualHhad}`.replace("让让", "让"),hhadMatched=hhad[0]?.score===hhadLabel;
 const strongHadReversal=forecastOutcome.probability>50&&isOppositeResult(forecastOutcome.score,actualOutcome,"胜","负");
 const strongHhadReversal=Boolean(hhad[0]?.probability>50&&isOppositeResult(hhad[0].score,hhadLabel,"让胜","让负"));
 const primary:ReviewPrimary=strongHadReversal||strongHhadReversal?"爆冷":outcomeMatched?"正常兑现":actualProbability<REVIEW_THRESHOLDS.upsetProbability&&leadGap>=REVIEW_THRESHOLDS.upsetGap?"爆冷":"合理偏差";
 const probabilityVector=["胜","平","负"].map(label=>(match.hadProbabilities||[]).find(point=>point.score===label)?.probability/100||0),actualIndex=["胜","平","负"].indexOf(actualOutcome);
 const brierScore=probabilityVector.reduce((sum,value,index)=>sum+Math.pow(value-(index===actualIndex?1:0),2),0);
 const causeTags=[primary];
 if(scoreRank>0&&scoreRank<=3)causeTags.push("比分覆盖");
 if(!hhadMatched)causeTags.push("让球偏差");
 const numericPredictedGoals=predictedGoals==="7+"?7:Number(predictedGoals);
 if(totalReasonableDeviation)causeTags.push("总进球合理偏差");
 if(totalOutsideTopTwo&&Number.isFinite(numericPredictedGoals))causeTags.push(actualGoals>numericPredictedGoals?"大球偏离":"小球偏离");
 if(actualHalfFull==="胜负"||actualHalfFull==="负胜")causeTags.push("半全场逆转");
 if(match.completeness<7||match.singleModel)causeTags.push("数据不完整");
 if(match.aiRisk)causeTags.push("赛前情报缺口");
 if(!outcomeMatched)causeTags.push("赛中事件待核验");
 const scoreSentence=scoreRank>0&&scoreRank<=3?`实际比分 ${actualScore} 位于赛前第 ${scoreRank} 选择，比分覆盖成功。`:`实际比分 ${actualScore} 未进入赛前前三选择。`;
 const goalSentence=predictedGoalPoint?`总进球赛前首选 ${predictedGoalPoint.score}（${predictedGoalPoint.probability.toFixed(1)}%）${goals[1]?`，次选 ${goals[1].score}（${goals[1].probability.toFixed(1)}%）`:""}；实际为 ${actualGoalLabel}球，${totalMatched?"首选命中":totalReasonableDeviation?"次选命中，属于合理偏差":actualGoals>numericPredictedGoals?"属于大球偏离":"属于小球偏离"}。`:"赛前快照未保存总进球概率。";
 const halfSentence=actualHalfFull?`实际半全场为 ${actualHalfFull}，${halfFull[0]?`赛前首选 ${halfFull[0].score}（${halfFull[0].probability.toFixed(1)}%），${halfFullMatched?"判断一致":"走势判断未命中"}。`:"旧快照没有半全场预测。"}`:"未取得可靠半场比分，无法核验半全场。";
 const evidenceSentence="当前已证实证据仅包括官方半场与全场赛果；尚无红牌、点球、伤退、首发和射门时间线，不能把偏差直接归因于具体赛中事件。";
 const reversalSentence=strongHadReversal?"胜平负强方向超过 50% 后赛果完全反向，按规则判为爆冷，不计合理偏差。":strongHhadReversal?"让球胜平负强方向超过 50% 后赛果完全反向，按规则判为爆冷，不计合理偏差。":"";
 const summary=`赛前胜平负首选 ${forecastOutcome.score}（${forecastOutcome.probability.toFixed(1)}%），实际为 ${actualOutcome}；实际结果的赛前概率为 ${actualProbability.toFixed(1)}%，排名第 ${actualRank}，归类为“${primary}”。${reversalSentence}${scoreSentence}${goalSentence}${halfSentence}${evidenceSentence}`;
 const improvements:string[]=[];
 const improvementAreas:ImprovementArea[]=[];
 if(!outcomeMatched){improvements.push("补充临场首发、核心伤停、轮换强度及封盘前欧亚盘口变化，检查赛前方向是否遗漏可获取信号。");improvementAreas.push("赛前情报覆盖");}
 if(scoreRank===0){improvements.push("使用历史赛果校准精确比分分布的离散程度和低比分相关性，降低独立泊松对尾部比分的低估。");improvementAreas.push("比分分布校准");}
 if(!hhadMatched){improvements.push("复核体彩固定让球与外围亚洲盘的净胜球映射，并用同一比分分布重新归并让球赛果。");improvementAreas.push("让球分布校准");}
 if(totalOutsideTopTwo){improvements.push("复核大小球盘口到预期进球的映射，并按历史赛果收缩进球均值和尾部分布。");improvementAreas.push("总进球校准");}
 if(actualHalfFull&&halfFull.length&&!halfFullMatched){improvements.push("按历史半场进球占比调整上下半场强度，并结合领先后策略和追分能力改进状态转移模型。");improvementAreas.push("半全场状态转移");}
 if(!predictedGoalPoint||!halfFull.length){improvements.push("旧快照缺少总进球或半全场原始概率；该问题属于历史数据缺失，不应计为模型预测错误。");improvementAreas.push("历史快照完整性");}
 if(!outcomeMatched||scoreRank===0||!hhadMatched||totalOutsideTopTwo||(actualHalfFull&&halfFull.length&&!halfFullMatched)){improvements.push("接入红牌、点球、伤退、射正与 xG 时间线后再判断是否属于事件驱动，避免事后归因。");improvementAreas.push("赛中事件数据");}
 if(match.aiRisk)improvements.push(`赛前AI已披露的缺口：${match.aiRisk}`);
 return{primary,causeTags:Array.from(new Set(causeTags)),evidenceLevel:"基础赛果已证实 · 赛中原因待核验",predictability:outcomeMatched?"高":primary==="合理偏差"?"中":"低",summary,improvements,improvementAreas:Array.from(new Set(improvementAreas)),actualOutcomeProbability:actualProbability,brierScore,outcomeMatched,hhadMatched,scoreRank,totalMatched,totalGoalRank:actualGoalRank,totalTopTwoMatched,halfFullMatched};
}
