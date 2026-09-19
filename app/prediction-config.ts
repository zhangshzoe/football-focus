export const PREDICTION_STORAGE_KEY="ff-today-predictions-v3";
export const PREDICTION_SNAPSHOT_STORAGE_KEY="ff-prediction-snapshots-v1";
export const PREDICTION_RESULT_CACHE_STORAGE_KEY="ff-prediction-results-v1";
export const PREDICTION_REVIEW_CACHE_STORAGE_KEY="ff-post-match-reviews-v1";
export const PREDICTION_CALIBRATION_STORAGE_KEY="ff-model-calibration-v1";
// 试运行：经过验证的赛前情报参与融合，但市场赔率仍是主要基线。
export const MODEL_WEIGHTS={odds:0.6,intelligence:0.4} as const;
export const DATA_FRESHNESS_MS=6*60*60*1000;
export const OFFICIAL_REFRESH_TIERS=[{withinMs:2*60*60*1000,refreshMs:3*60*1000,maxPredictionAgeMs:20*60*1000},{withinMs:6*60*60*1000,refreshMs:10*60*1000,maxPredictionAgeMs:60*60*1000},{withinMs:24*60*60*1000,refreshMs:20*60*1000,maxPredictionAgeMs:3*60*60*1000},{withinMs:Number.POSITIVE_INFINITY,refreshMs:60*60*1000,maxPredictionAgeMs:6*60*60*1000}] as const;
export const parseZonedKickoff=(value?:string|null)=>{const text=String(value||"").trim();return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)?Date.parse(text):NaN};
export const predictionKickoffParts=(match:{kickoffAt?:string|null;matchDate?:string|null;time?:string|null})=>{
 const zoned=parseZonedKickoff(match.kickoffAt),fallbackDate=String(match.matchDate||match.time||"").match(/\d{4}[-/](\d{2})[-/](\d{2})/),fallbackClock=String(match.time||match.kickoffAt||match.matchDate||"").match(/(?:T|\s|^)(\d{1,2}):(\d{2})/);
 if(Number.isFinite(zoned)){const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(new Date(zoned)).map(part=>[part.type,part.value]));return{date:`${parts.month}-${parts.day}`,time:`${parts.hour}:${parts.minute}`,label:`${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`}}
 const date=fallbackDate?`${fallbackDate[1]}-${fallbackDate[2]}`:"—",time=fallbackClock?`${fallbackClock[1].padStart(2,"0")}:${fallbackClock[2]}`:"—";return{date,time,label:date!=="—"?`${date.replace("-","/")} ${time}`:time};
};
export const refreshPolicy=(kickoffAt?:string|null,now=Date.now())=>{const kickoff=parseZonedKickoff(kickoffAt),distance=Number.isFinite(kickoff)?Math.max(0,kickoff-now):Number.POSITIVE_INFINITY;return OFFICIAL_REFRESH_TIERS.find(tier=>distance<=tier.withinMs)||OFFICIAL_REFRESH_TIERS.at(-1)!};
export const MIN_COMPLETENESS=7;
export const MAX_COMBINATION_CANDIDATES=12;

export type CalibrationBucket={sampleSize:number;meanTotalGoals:number;goalDispersion:number;firstHalfGoalShare:number;lowScoreRho?:number};
export type CalibrationMetrics={brier:number;logLoss:number;sampleSize:number;coverage:number;buckets:Array<{range:string;count:number;meanProbability:number;observedRate:number}>};
export type ModelCalibrationProfile={version:1|2|3;profileId?:string;status?:"validated"|"insufficient_data";generatedAt:string;decisionPolicy?:string;splitPolicy?:string;forecastSampleSize:number;uniqueMatchCount:number;coverage?:number;trainingSampleSize?:number;calibrationSampleSize?:number;testSampleSize?:number;probabilityTemperature:number;intelligenceWeightMultiplier?:number;intelligenceValidation?:{sampleSize:number;baseBrier:number;fusedBrier:number;delta:number;status:"validated_gain"|"no_gain"|"insufficient_data"};rawBrier:number;calibratedBrier:number;fitting?:{raw:CalibrationMetrics;calibrated:CalibrationMetrics};futureTest?:{raw:CalibrationMetrics;calibrated:CalibrationMetrics;marketBaseline:CalibrationMetrics};rollingValidation?:{folds:number;wins?:number;sampleSize:number;calibrated:CalibrationMetrics;marketBaseline:CalibrationMetrics};promotionGates?:Array<{key:string;label:string;passed:boolean;value:string}>;simulationReturn?:null|{stake:number;return:number;roi:number;sampleSize:number};global:CalibrationBucket;leagues:Record<string,CalibrationBucket>};

export type ScorePoint={score:string;probability:number};
export type SavedMarketEligibility={marketCode:string;handicap:string|null;salesStatus:string;supportsSingle:boolean;allowedPassCounts:number[];cutoffAt:string|null;ruleVersion:string;qualification:string};
export type SavedPrediction={
 predictionId?:string;inputSnapshotId?:string;baseModelVersion?:string;calibrationVersion?:string;predictionGeneratedAt?:string;fullScoreDistribution?:ScorePoint[];expectedGoals?:{home:number;away:number};intelligenceEvidence?:{records:Array<{type:string;sourceUrl:string;observedAt:string;summary?:string}>};appliedIntelligenceWeight?:number;id:string;officialMatchId?:string;salesDate?:string;kickoffAt?:string;homeTeamId?:string;awayTeamId?:string;homeTeamCode?:string;awayTeamCode?:string;officialMappingStatus?:string;marketEligibility?:Partial<Record<string,SavedMarketEligibility>>;league:string;time:string;matchDate?:string;home:string;away:string;matchStatus?:string;isMock?:boolean;
 oddsScores:ScorePoint[];marketHadProbabilities?:ScorePoint[];intelligenceScores?:ScorePoint[];combinedScores?:ScorePoint[];shadowFullScoreDistribution?:ScorePoint[];shadowHadProbabilities?:ScorePoint[];intelligenceCoverage?:number;aiSummary?:string;aiRisk?:string;
 hadProbabilities?:ScorePoint[];hhadProbabilities?:ScorePoint[];totalGoalProbabilities?:ScorePoint[];halfFullProbabilities?:ScorePoint[];handicap?:string;
 confidence:number;completeness:number;singleModel?:boolean;sourceFetchedAt:string;generatedAt:string;
};
export type SavedPredictionVersion={predictionId:string;inputSnapshotId:string;baseModelVersion:string;calibrationVersion:string;aiReviewVersion?:string|null;reviewForPredictionId?:string;parentPredictionId?:string|null;generatedAt:string;aiReviewedAt?:string};
export type SavedPredictionSet={historyRecordId?:string;predictionId?:string;version?:SavedPredictionVersion;date:string;scheduledAt?:string;capturedAt?:string;upstreamUpdatedAt?:string;sourceFetchedAt:string;aiCompletedAt?:string;decisionTiming?:"pre_match"|"in_play"|"unknown";aiProvider?:string;matches:SavedPrediction[]};
