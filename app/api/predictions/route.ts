/* eslint-disable @typescript-eslint/no-explicit-any */
import {createBasePredictionVersion,deriveMarkets,predictionHash} from "../../prediction-version";
import {getPublishedCalibration,MIN_TEMPERATURE_CALIBRATION_MATCHES} from "../../calibration-service";
import {PREDICTION_PIPELINE_VERSION,predictFromSnapshot,compatibleCalibration} from "../../prediction-model.js";
import {createPredictionComputeCache} from "../../prediction-compute-cache.js";
import {normalizeCompany,assessPredictionInput,createOddsBatchLoader} from "../../prediction-input.js";
import {deVig,asianMarketTarget,validAsianLine} from "../../asian-market.js";
import {TEAM_ALIAS_VERSION,teamIdentity,teamNamesCompatible} from "../../team-identity.js";
import {readContextBatch} from "../../match-context-service";
import {fitTeamStrength} from "../../team-strength-model.js";
import teamHistoryIndex from "../../../data/generated-team-history-index.json";
import {selectTeamHistory} from "../../team-history.js";
import {signContextProof} from "../../context-evidence.js";
import {fetchOfficialSporttery,OfficialSportteryError} from "../../sporttery-official";
type CompanyOdds = {
  companyId: number;
  company: string;
  win: number;
  draw: number;
  lose: number;
  handicap: number;
  homePrice: number;
  awayPrice: number;
  total: number;
  overPrice: number;
  underPrice: number;
  firstWin: number;
  firstDraw: number;
  firstLose: number;
  firstHandicap: number;
  firstHomePrice: number;
  firstAwayPrice: number;
  firstTotal: number;
  firstOverPrice: number;
  firstUnderPrice: number;
};
type CalibrationBucket={sampleSize:number;meanTotalGoals:number;goalDispersion:number;firstHalfGoalShare:number;lowScoreRho?:number};
type ModelCalibrationProfile={version:number;profileId?:string;status?:string;forecastSampleSize:number;uniqueMatchCount:number;trainingSampleSize?:number;calibrationSampleSize?:number;probabilityTemperature:number;intelligenceWeightMultiplier?:number;global:CalibrationBucket;leagues:Record<string,CalibrationBucket>};

const COMPANY_IDS = [2, 3, 22];
const predictionComputeCache = createPredictionComputeCache({compute:predictFromSnapshot});
const SOURCE_URL = "https://plzx.zgzcw.com/";
const DATA_URL = "https://plzx.zgzcw.com/odds/oyzs_ajax.action";
const EV_THRESHOLD = 0.05;
const TOTAL_GOAL_LABELS = ["0球", "1球", "2球", "3球", "4球", "5球", "6球", "7+球"];
const HALF_FULL_LABELS = ["胜胜", "胜平", "胜负", "平胜", "平平", "平负", "负胜", "负平", "负负"];
const numeric = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const fetchCompanyOdds = createOddsBatchLoader(async (issue:string) => {
  const response = await fetch(DATA_URL, {
    method:"POST", headers:{"content-type":"application/x-www-form-urlencoded",referer:SOURCE_URL,"x-requested-with":"XMLHttpRequest"},
    body:new URLSearchParams({type:"",issue,date:"",companys:COMPANY_IDS.join(",")}),cache:"no-store",
    signal:AbortSignal.timeout(15000),
  });
  if(!response.ok)throw new Error(`赔率源响应 ${response.status}`);
  const text=await response.text();
  if(/Access Verification|请求过于频繁|人机验证/.test(text))throw new Error("足彩网触发访问频率保护，请稍后再试；不会使用虚构赔率替代");
  const rows=JSON.parse(text);
  if(!Array.isArray(rows))throw new Error("足彩网赔率格式发生变化");
  return rows;
});
const parsedCompanies=(match:any,fetchedAt:string):any[] =>
  (Array.isArray(match.listOdds)?match.listOdds:[]).filter((row:any)=>COMPANY_IDS.includes(Number(row.SOURCE_COMPANY_ID))).map((row:any)=>normalizeCompany(row,fetchedAt));
const displayCompanies=(rows:any[])=>rows.filter(row=>deVig([row.win,row.draw,row.lose],3));
const inputSnapshot=(companies:any[],decisionAt:string,official:any={})=>({
  schemaVersion:1,pipelineVersion:PREDICTION_PIPELINE_VERSION,decisionAt,companies,
  official:{officialMatchId:String(official.officialMatchId||official.matchId||""),salesDate:official.salesDate||"",kickoffAt:official.kickoffAt||"",
    hadOdds:official.odds||[],handicap:official.marketEligibility?.["让球胜平负"]?.qualification==="qualified"?nullableHandicap(official.marketEligibility["让球胜平负"].handicap??official.handicap):null,
    hhadOdds:official.marketEligibility?.["让球胜平负"]?.qualification==="qualified"?(official.hhadOdds||[]):[],
    totalOdds:official.marketOdds?.["总进球数"]||[],scoreOdds:official.marketOdds?.["比分"]||[],halfFullOdds:official.marketOdds?.["半全场"]||[],fetchedAt:official.sourceFetchedAt||official.fetchedAt||null,updatedAt:official.updatedAt||null}
});

function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validCalibrationBucket(value:unknown):CalibrationBucket|null{
 const bucket=value as Partial<CalibrationBucket>|null;
 if(!bucket||!Number.isFinite(bucket.sampleSize)||!Number.isFinite(bucket.meanTotalGoals)||!Number.isFinite(bucket.goalDispersion)||!Number.isFinite(bucket.firstHalfGoalShare))return null;
 return{sampleSize:Number(bucket.sampleSize),meanTotalGoals:Math.max(1.2,Math.min(4.5,Number(bucket.meanTotalGoals))),goalDispersion:Math.max(.85,Math.min(1.6,Number(bucket.goalDispersion))),firstHalfGoalShare:Math.max(.35,Math.min(.55,Number(bucket.firstHalfGoalShare))),lowScoreRho:Math.max(-.15,Math.min(.15,Number(bucket.lowScoreRho)||0))};
}

function normalized1x2(rows: CompanyOdds[], sporttery: number[]) {
  const sources = rows.map((row) => [row.win, row.draw, row.lose]).filter((odds) => odds.every((odd) => odd > 1));
  if (sporttery?.length === 3 && sporttery.every((odd) => odd > 1)) sources.push(sporttery);
  const probabilities = sources.map((odds) => {
    const raw = odds.map((odd) => 1 / odd);
    const total = raw.reduce((sum, value) => sum + value, 0);
    return raw.map((value) => value / total);
  });
  return [0, 1, 2].map((index) => median(probabilities.map((row) => row[index])));
}

function deVigDecimal(odds: number[]) {
  if (odds.length !== 3 || !odds.every((odd) => odd > 1)) return [];
  const raw = odds.map((odd) => 1 / odd);
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value / total);
}

function deVigHongKong(homePrice: number, awayPrice: number) {
  if (!(homePrice > 0) || !(awayPrice > 0)) return [Number.NaN, Number.NaN];
  const raw = [1 / (1 + homePrice), 1 / (1 + awayPrice)];
  const total = raw[0] + raw[1];
  return raw.map((value) => value / total);
}

function handicapMeaning(asianLine: number, officialLine: number|null) {
  const asian = asianLine < 0 ? `外围主队让 ${Math.abs(asianLine)} 球` : asianLine > 0 ? `外围主队受让 ${asianLine} 球` : "外围平手盘";
  if (officialLine===null || !Number.isFinite(officialLine)) return `${asian}；体彩让球玩法缺失，不能生成可执行的让球结论。`;
  if (officialLine < 0) return `${asian}；体彩主队 ${officialLine}，主队需净胜超过 ${Math.abs(officialLine)} 球才是让胜，净胜 ${Math.abs(officialLine)} 球为让平。`;
  return `${asian}；体彩主队 +${officialLine}，客队需净胜超过 ${officialLine} 球才是让负，净胜 ${officialLine} 球为让平。`;
}

function movementLabel(first: number, current: number) {
  if (!Number.isFinite(first) || !Number.isFinite(current)) return "数据不足";
  const delta = current - first;
  return Math.abs(delta) < 0.005 ? "持平" : delta < 0 ? "降赔" : "升赔";
}

function handicapExpectation(line: number) {
  if (!Number.isFinite(line)) return "盘口深度未知";
  const abs = Math.abs(line);
  const description = line < 0 ? `主队让${abs}球` : line > 0 ? `主队受让${abs}球` : "平手盘";
  return `${description}；盘口线是结算条件，不直接代表净胜球预测区间`;
}

function interpretInstitutionAction(firstLine: number, line: number, firstHome: number, home: number, firstAway: number, away: number) {
  if (![firstLine,line,firstHome,home,firstAway,away].every(Number.isFinite)) return "初盘或即盘信息不足，不描述报价变化";
  const lineDelta = line - firstLine;
  const homeMove = movementLabel(firstHome, home);
  const awayMove = movementLabel(firstAway, away);
  const lineText = Math.abs(lineDelta) < 0.005 ? `主队盘口线保持${line}` : `主队盘口线由${firstLine}变为${line}`;
  return `${lineText}；主队价格${homeMove}、客队价格${awayMove}。仅描述报价，不推断机构意图`;
}

function expectedValue(probabilities: number[], odds: number[]) {
  if (!Array.isArray(odds) || odds.length !== probabilities.length) return [];
  return odds.map((odd, index) => odd > 1 ? probabilities[index] * odd - 1 : Number.NaN);
}

const datePart=(value:unknown)=>String(value||"").match(/\d{4}-\d{2}-\d{2}/)?.[0]||"";
const clockPart=(value:unknown)=>String(value||"").match(/\d{2}:\d{2}/)?.[0]||"";
const normalizedTeam=(value:unknown,league:unknown="")=>teamIdentity(value,String(league||""));
const minutes=(clock:string)=>{const [hour,minute]=clock.split(":").map(Number);return Number.isFinite(hour)&&Number.isFinite(minute)?hour*60+minute:Number.NaN};
function verifyOfficialMapping(external:any,officialMatches:any[],issue:string){
 const league=external.LEAGUE_NAME_SIMPLY,externalDate=datePart(external.MATCH_TIME)||datePart(external.MATCH_DATE)||issue,externalClock=clockPart(external.MATCH_TIME),home=normalizedTeam(external.HOST_NAME,league),away=normalizedTeam(external.GUEST_NAME,league);
 const sameSchedule=(item:any)=>{
  const officialDate=datePart(item.kickoffAt)||datePart(item.matchDate)||datePart(item.time)||datePart(item.salesDate),officialClock=clockPart(item.kickoffAt)||clockPart(item.time);
  return officialDate===externalDate&&externalClock!==""&&officialClock!==""&&Math.abs(minutes(officialClock)-minutes(externalClock))<=45;
 };
 const sameTeams=(item:any)=>!!home&&!!away&&normalizedTeam(item.home,item.league)===home&&normalizedTeam(item.away,item.league)===away;
 const sameDisplayId=(item:any)=>String(item.id||"")===String(external.CC_ID||"");
 const compatibleTeams=(item:any)=>teamNamesCompatible(item.home,external.HOST_NAME,item.league,league)&&teamNamesCompatible(item.away,external.GUEST_NAME,item.league,league);
 const verifiedTeams=(item:any)=>sameTeams(item)||(sameDisplayId(item)&&compatibleTeams(item));
 const reversed=officialMatches.filter(item=>teamNamesCompatible(item.home,external.GUEST_NAME,item.league,league)&&teamNamesCompatible(item.away,external.HOST_NAME,item.league,league)&&sameSchedule(item));
 const candidates=officialMatches.filter(item=>String(item.id||"")===String(external.CC_ID||"")||normalizedTeam(item.home,item.league)===home||normalizedTeam(item.away,item.league)===away||reversed.includes(item));
 const verified=candidates.filter(item=>verifiedTeams(item)&&sameSchedule(item));
 if(verified.length===1)return{official:verified[0],status:"verified",reason:`彩票编号、日期、主客队与开赛时间均已通过校验（球队别名版本 ${TEAM_ALIAS_VERSION}）`,candidateOfficialMatchIds:[]};
 const candidateOfficialMatchIds=candidates.map(item=>String(item.officialMatchId||item.matchId||"")).filter(Boolean);
 if(verified.length>1)return{official:null,status:"pending_verification",reason:"存在多场同队同时间赛事，无法唯一确认官方比赛",candidateOfficialMatchIds};
 if(reversed.length)return{official:null,status:"pending_verification",reason:"外围盘口的主客队顺序与官方赛程相反，暂停生成预测",candidateOfficialMatchIds};
 const reasons=[];if(!candidates.some(verifiedTeams))reasons.push("主客队名称尚未匹配");
 if(!candidates.some(item=>(datePart(item.kickoffAt)||datePart(item.matchDate)||datePart(item.time)||datePart(item.salesDate))===externalDate))reasons.push("比赛日期不一致");
 if(!externalClock)reasons.push("外围开赛时间缺失");else if(!candidates.some(item=>{const clock=clockPart(item.kickoffAt)||clockPart(item.time);return clock&&Math.abs(minutes(clock)-minutes(externalClock))<=45}))reasons.push("开赛时间不一致");
 return{official:null,status:"pending_verification",reason:reasons.join("、")||"无法唯一确认官方赛事",candidateOfficialMatchIds};
}
function nullableHandicap(value:unknown){const text=String(value??"").trim();if(!text)return null;const parsed=Number(text);return Number.isFinite(parsed)?parsed:null}

export async function POST(request: Request) {
  const input = await request.json().catch(() => null);
  // The caller selects identities only. Quotes, eligibility and observation times
  // are always re-read on the server, never certified from request.body.
  const selectors: unknown[] = Array.isArray(input?.fixtureIds)
    ? input.fixtureIds
    : Array.isArray(input?.matches)
      ? input.matches.map((match:any) => match?.officialMatchId || match?.matchId)
      : [];
  if (selectors.length > 120 || selectors.some(id => typeof id !== "string" || !id.trim()))
    return Response.json({error:"请提供最多120个有效官方比赛ID；不接受客户端赔率作为官方证据。"},{status:400});
  const requestedIds = new Set(selectors.map(id => String(id).trim()));
  const forceRefresh = input?.forceRefresh === true;
  if (!requestedIds.size) return Response.json({reports:[],fetchedAt:new Date().toISOString(),sourceUrl:SOURCE_URL,methodology:"没有可确认的官方比赛，未执行赔率模型。"});
  try {
  const officialData = await fetchOfficialSporttery({repair:forceRefresh,serverHeaders:true});
  const officialFetchedAt = Date.parse(officialData.fetchedAt), verificationAt = Date.now();
  if (!Number.isFinite(officialFetchedAt) || officialFetchedAt > verificationAt || verificationAt - officialFetchedAt > 300000)
    throw new Error("服务器官方赔率读取时刻无效或已过期，未生成正式预测。");
  const sportteryMatches: any[] = officialData.matches
    .filter(match => requestedIds.has(String(match.officialMatchId || match.matchId)))
    .map(match => ({...match,sourceFetchedAt:officialData.fetchedAt,hhadOdds:match.marketOdds?.["让球胜平负"],isMock:false}));
  const matchedIds = new Set(sportteryMatches.map(match => String(match.officialMatchId || match.matchId)));
  const unavailableIds = [...requestedIds].filter(id => !matchedIds.has(id));
  if (unavailableIds.length) return Response.json({error:"所选比赛已不在服务器最新官方清单中，请刷新比赛后重试。",code:"OFFICIAL_FIXTURE_NOT_CURRENT",unavailableOfficialMatchIds:unavailableIds},{status:409});
  const calibrationProfile = await getPublishedCalibration() as Partial<ModelCalibrationProfile> | null;
  const globalCalibration = compatibleCalibration(calibrationProfile)&&calibrationProfile?.trainingSampleSize&&calibrationProfile.trainingSampleSize>=20
    ? validCalibrationBucket(calibrationProfile.global)
    : null;
  const probabilityTemperature = compatibleCalibration(calibrationProfile)&&calibrationProfile?.calibrationSampleSize&&calibrationProfile.calibrationSampleSize>=MIN_TEMPERATURE_CALIBRATION_MATCHES
    ? Math.max(.7, Math.min(2.5, numeric(calibrationProfile.probabilityTemperature) || 1))
    : 1;
    const issue = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const issues=Array.from(new Set(sportteryMatches.map(match=>datePart(match.salesDate)).filter(Boolean)));if(!issues.length)issues.push(issue);
    const batches=await Promise.allSettled(issues.map(saleIssue=>fetchCompanyOdds(saleIssue,forceRefresh)));
    const sourceFailures=batches.flatMap((result,index)=>result.status==="rejected"?[{issue:issues[index],reason:String(result.reason?.message||result.reason)}]:[]);
    const rawRows:any[]=batches.flatMap(result=>result.status==="fulfilled"?result.value.rows.map((match:any)=>({...match,__issue:result.value.issue,__fetchedAt:result.value.fetchedAt})):[]);
    const raw:any[]=Array.from(new Map(rawRows.map(match=>[`${match.__issue}|${match.CC_ID||""}|${match.MATCH_ID||match.ID||""}`,match])).values());
    if(!raw.length&&sourceFailures.length)throw new Error(sourceFailures.map(row=>row.issue+": "+row.reason).join("；"));
    const contexts=await readContextBatch(sportteryMatches);
    const generatedAt=new Date().toISOString();
    const pendingVerification:any[]=[];
    const reports = raw.filter((match) => String(match.CC_ID || "").includes("周")).map((match) => {
      const sourceCompanies=parsedCompanies(match,match.__fetchedAt),companies=displayCompanies(sourceCompanies);
      const saleIssue=String(match.__issue||issue),mapping=verifyOfficialMapping(match,sportteryMatches,saleIssue),official=mapping.official;
      if (!official){pendingVerification.push({externalId:String(match.MATCH_ID||match.ID||""),displayId:String(match.CC_ID||""),matchDate:datePart(match.MATCH_TIME)||saleIssue,time:clockPart(match.MATCH_TIME),home:String(match.HOST_NAME||""),away:String(match.GUEST_NAME||""),mappingStatus:mapping.status,reason:mapping.reason,candidateOfficialMatchIds:mapping.candidateOfficialMatchIds});return null}
      const modelInput=inputSnapshot(sourceCompanies,generatedAt,official),dataQuality=assessPredictionInput(sourceCompanies,generatedAt);
      const matchContext=contexts.get(String(official.officialMatchId||official.matchId))||{status:"unavailable",missing:["赛事资料读取未完成"],sources:[]};
      Object.assign(modelInput,{matchContext});
      if(dataQuality.status!=="ready"){pendingVerification.push({reason:dataQuality.reasons.join("；"),candidateOfficialMatchIds:[String(official.officialMatchId||official.matchId)],displayId:match.CC_ID});return null}
      const totalLine = median(sourceCompanies.filter(row=>validAsianLine(row.total)&&row.total>0).map(row=>row.total));
      const handicap = median(sourceCompanies.filter(row=>validAsianLine(row.handicap)).map(row=>row.handicap));
      const asianHomeTarget = median(companies.map((row) => deVigHongKong(row.homePrice, row.awayPrice)[0]));
      const initialAsianHomeTarget = median(companies.map((row) => deVigHongKong(row.firstHomePrice, row.firstAwayPrice)[0]));
      const overTarget = median(companies.map((row) => deVigHongKong(row.overPrice, row.underPrice)[0]));
      const hhadEligibility=official?.marketEligibility?.["让球胜平负"],officialHandicap=hhadEligibility?.qualification==="qualified"?nullableHandicap(hhadEligibility.handicap??official?.handicap):null;
      const officialHhadOdds=hhadEligibility?.qualification==="qualified"&&officialHandicap!==null?(official?.hhadOdds||[]):[];
      const officialHhadFair = deVigDecimal(officialHhadOdds);
      const league = String(match.LEAGUE_NAME_SIMPLY || official?.league || "");
      const teamHistory=selectTeamHistory(teamHistoryIndex,{league,decisionAt:generatedAt});
      Object.assign(modelInput,{teamHistory});
      const leagueCalibrationCandidate = calibrationProfile?.leagues?.[league];
      const leagueCalibration = compatibleCalibration(calibrationProfile) && leagueCalibrationCandidate && numeric(leagueCalibrationCandidate.sampleSize) >= 8
        ? validCalibrationBucket(leagueCalibrationCandidate)
        : null;
      const activeCalibration = leagueCalibration || globalCalibration;
      const modelParameters={...(activeCalibration||{}),temperature:probabilityTemperature};
      const modeled = predictionComputeCache.predict(modelInput,modelParameters,{mode:"official",calibrationId:String(calibrationProfile?.profileId||"cal-none")}),rawProbabilities:number[]=modeled.marketProbabilities,probabilities=rawProbabilities;
      const derived=deriveMarkets(modeled.fullScoreDistribution,officialHandicap),finalProbabilities=derived.hadProbabilities.map(point=>point.probability/100),finalHhad=derived.hhadProbabilities?.map(point=>point.probability)||[],finalGoals=derived.totalGoalProbabilities.map(point=>point.probability);
      const initialProbabilities = normalized1x2(companies.map(row=>({...row,win:row.firstWin,draw:row.firstDraw,lose:row.firstLose})), []);
      const currentExternalProbabilities = normalized1x2(companies, []);
      const shifts = currentExternalProbabilities.map((value,index)=>(value-initialProbabilities[index])*100);
      const movementAvailable=initialProbabilities.every(Number.isFinite)&&Number.isFinite(initialAsianHomeTarget);
      const asianMovement = movementAvailable?(asianHomeTarget - initialAsianHomeTarget) * 100:Number.NaN;
      // Descriptive movement only: do not add a second, unvalidated Asian-line
      // confidence weight to an outcome already fitted from these markets.
      const combinedDirectionScores = shifts;
      const movementDirectionIndex = combinedDirectionScores.indexOf(Math.max(...combinedDirectionScores));
      const directions = ["主队方向","平局方向","客队方向"];
      const directionIndex = finalProbabilities.indexOf(Math.max(...finalProbabilities));
      const firstHandicap = median(companies.map(row=>row.firstHandicap));
      const handicapChange = handicap-firstHandicap;
      const fairOdds = finalProbabilities.map(value=>value>0?1/value:0);
      const hadEv = expectedValue(finalProbabilities, modeled.officialFresh?(official?.odds || []):[]);
      const hhadEv = officialHandicap===null||!modeled.officialFresh?[]:expectedValue(finalHhad.map(value => value / 100), officialHhadOdds);
      const directionStrength = Math.max(...combinedDirectionScores);
      const fitAgreement = modeled.fitError < 0.012 ? "多盘口较一致" : modeled.fitError < 0.03 ? "部分一致" : "盘口分歧较大";
      const institutionAction = interpretInstitutionAction(firstHandicap, handicap, median(companies.map(row=>row.firstHomePrice)), median(companies.map(row=>row.homePrice)), median(companies.map(row=>row.firstAwayPrice)), median(companies.map(row=>row.awayPrice)));
      const expectation = handicapExpectation(handicap);
      const calibrationNarrative = activeCalibration ? `已使用 ${leagueCalibration ? league : "全局"} 历史样本 ${activeCalibration.sampleSize} 场，对概率锐度、总进球离散度、低比分相关性和半场进球占比作小幅校准。` : "历史有效样本不足，本场保持盘口模型基线；低比分相关修正保持影子状态，不以短样本强行启用。";
      const narrative = !movementAvailable?`初盘信息不足，不计算变盘方向。${calibrationNarrative}`:`当前模型概率最高为${directions[directionIndex]}；外围欧赔初盘与即盘的相对变化最大为${directions[movementDirectionIndex]}。${institutionAction}。同口径去水概率变化 ${shifts[movementDirectionIndex]>=0?"+":""}${shifts[movementDirectionIndex].toFixed(1)} 个百分点，亚盘主队侧结算权重比变化 ${asianMovement>=0?"+":""}${asianMovement.toFixed(1)} 个百分点。初/即盘未提供变更时间，不视为完整走势或独立预测证据。${expectation}；拟合一致性为“${fitAgreement}”。${calibrationNarrative}`;
      const spread = Math.max(...companies.map((row) => row.win), 0) - Math.min(...companies.map((row) => row.win), Number.POSITIVE_INFINITY);
      return {
        id: String(official.id),externalDisplayId:String(match.CC_ID),officialMatchId:String(official.officialMatchId||official.matchId),salesDate:String(official.salesDate||official.matchDate||""),kickoffAt:String(official.kickoffAt||""),homeTeamId:String(official.homeTeamId||""),awayTeamId:String(official.awayTeamId||""),homeTeamCode:String(official.homeTeamCode||""),awayTeamCode:String(official.awayTeamCode||""),officialMappingStatus:"verified",mappingReason:mapping.reason,marketEligibility:official.marketEligibility||{},league,
        time: String(official?.matchDate&&official?.time?`${official.matchDate} ${official.time}`:official?.kickoffAt||official?.time||match.MATCH_TIME||""), matchDate: String(official?.matchDate || match.MATCH_TIME || ""), home: String(official.home), away: String(official.away), matchStatus: official?.matchStatus || "", isMock: Boolean(official?.isMock), sourceUpdatedAt: official?.updatedAt || "",
        modelInput,modelParameters,dataQuality,sourceFetchedAt:match.__fetchedAt,officialOddsFresh:modeled.officialFresh,officialVerification:{method:"server-refetch",fetchedAt:officialData.fetchedAt,source:officialData.source,sourcePage:officialData.sourcePage},marketTotalGoalProbabilities:modeled.marketTotalGoalProbabilities,priceDiagnostics:modeled.priceDiagnostics,
        companies, marketProbabilities:rawProbabilities.map(value=>value*100),probabilities: {home: finalProbabilities[0] * 100, draw: finalProbabilities[1] * 100, away: finalProbabilities[2] * 100},
        consensus: {handicap, totalLine, agreement: companies.length === 3 && spread < 0.3 && modeled.fitError < 0.03 ? "较一致" : "有分歧"},
        marketSignal: {direction:directions[directionIndex],movementDirection:directions[movementDirectionIndex],strength:directionStrength,probabilityShifts:shifts,fairOdds,hadEv,hhadEv,evThreshold:EV_THRESHOLD,institutionAction,handicapExpectation:expectation,firstHandicap,handicapChange,narrative,officialOdds:official?.odds||[],officialHandicap:officialHandicap===null?"":String(officialHandicap),officialHhadOdds,officialHhadFair:officialHhadFair.map(value=>value*100),modeledHhad:finalHhad,hhadAvailable:officialHandicap!==null&&officialHhadOdds.length===3,modeledTotalGoals:finalGoals,totalGoalLabels:TOTAL_GOAL_LABELS,modeledHalfFull:modeled.halfFullProbabilities,halfFullLabels:HALF_FULL_LABELS,asianHomeProbability:asianHomeTarget*100,asianAwayProbability:(1-asianHomeTarget)*100,asianMovement,overProbability:overTarget*100,fitAgreement,handicapMeaning:handicapMeaning(handicap,officialHandicap),rawProbabilities:rawProbabilities.map(value=>value*100),calibrationSampleSize:activeCalibration?.sampleSize||0,probabilityTemperature,historicalMeanTotalGoals:activeCalibration?.meanTotalGoals,goalDispersion:activeCalibration?.goalDispersion,firstHalfGoalShare:activeCalibration?.firstHalfGoalShare,lowScoreRho:modeled.lowScoreRho},
        matchContext,teamStrengthCandidate:{...fitTeamStrength(teamHistory.rows,{league,homeTeamId:matchContext.homeTeamId,awayTeamId:matchContext.awayTeamId,decisionAt:generatedAt}),history:teamHistory},modelMarketEligibility:{halfFull:{status:"research-only",reason:"条件进球分配近似，尚未独立前瞻验证"}},expectedGoals: {home: modeled.expectedGoals[0], away: modeled.expectedGoals[1]}, scores: modeled.scores,fullScoreDistribution:modeled.fullScoreDistribution,
        missingCompanies: COMPANY_IDS.filter((id) => !companies.some((row) => row.companyId === id)),
      };
    }).filter(Boolean);
    const calibrationVersion=globalCalibration?String(calibrationProfile?.profileId||`cal-${predictionHash(calibrationProfile)}`):"cal-none",version=createBasePredictionVersion(reports,calibrationVersion,generatedAt);
    const versionedReports=await Promise.all(reports.map(async report=>{const row={...report,predictionId:version.predictionId,inputSnapshotId:version.inputSnapshotId,baseModelVersion:version.baseModelVersion,calibrationVersion:version.calibrationVersion,predictionGeneratedAt:version.generatedAt};return {...row,contextProof:await signContextProof(row,process.env.MATCH_CONTEXT_SIGNING_KEY||process.env.DEEPSEEK_API_KEY)};}));
    const coveredIds=new Set(reports.map((report:any)=>String(report.officialMatchId||"")));
    const unavailableOfficialMatches=sportteryMatches.filter(match=>!coveredIds.has(String(match.officialMatchId||match.matchId||""))).map(match=>{
      const officialMatchId=String(match.officialMatchId||match.matchId||"");
      const related=pendingVerification.filter(record=>record.candidateOfficialMatchIds?.includes(officialMatchId));
      const reasons=Array.from(new Set(related.map(record=>record.reason)));
      const externalCandidates=related.map(record=>({displayId:record.displayId,home:record.home,away:record.away,matchDate:record.matchDate,time:record.time}));
      return{id:match.id,officialMatchId,salesDate:match.salesDate,kickoffAt:match.kickoffAt,matchDate:match.matchDate,time:match.time,league:match.league,home:match.home,away:match.away,reason:reasons.join("；")||sourceFailures.find(source=>source.issue===datePart(match.salesDate))?.reason||"外围盘口尚未提供可核验的本场数据",externalCandidates};
    });
    const coverage={officialMatches:sportteryMatches.length,predictedMatches:versionedReports.length,unavailableMatches:unavailableOfficialMatches.length,pendingExternalMappings:pendingVerification.length};
    return Response.json({predictionId:version.predictionId,version,reports:versionedReports,officialMatches:sportteryMatches,officialSource:{method:"server-refetch",manifestState:officialData.manifestState,poolStatus:officialData.poolStatus,fetchedAt:officialData.fetchedAt,upstreamUpdatedAt:officialData.upstreamUpdatedAt,source:officialData.source,sourcePage:officialData.sourcePage},pendingVerification,unavailableOfficialMatches,coverage,sourceFailures, fetchedAt: generatedAt, sourceUrl: SOURCE_URL, methodology: `覆盖 ${coverage.predictedMatches}/${coverage.officialMatches} 场官方赛事；${coverage.unavailableMatches} 场因外围盘口缺失或身份未通过校验而不生成概率，另有 ${coverage.pendingExternalMappings} 条外围记录待核验。多盘口交叉校准：三家公司欧赔初盘/即盘、亚洲让球水位、大小球与体彩胜平负/固定让球盘共同约束预期进球；${globalCalibration ? `使用服务端校准版本 ${calibrationProfile?.profileId}，其参数只由训练/校准区间确定，并已保留未来测试区间；低比分相关参数 ${globalCalibration.lowScoreRho||0}` : "尚无通过未来测试门槛的服务端校准版本，保持盘口模型基线，Dixon–Coles 低比分修正处于影子验证"}；外围赛事仅在日期、主客队与开赛时间全部通过官方校验后进入可执行预测，盘口冲突会降低一致度。`});
  } catch (error) {
    return Response.json({error: error instanceof Error ? error.message : "赔率数据读取失败",
      ...(error instanceof OfficialSportteryError?{code:error.code,sourceState:error.sourceState}:{})}, {status: 502});
  }
}

// 仅供 AI 预测页研究。外围编号不是竞彩官方身份，这些记录不得进入选号、固定票或正式复盘。
export async function GET() {
  const issue = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    const batch = await fetchCompanyOdds(issue),raw=batch.rows;
    const fetchedAt = batch.fetchedAt,decisionAt=new Date().toISOString();
    const now = Date.now();
    const unavailable: Array<{displayId:string;home:string;away:string;reason:string}> = [];
    const candidates = Array.from(new Map(raw.filter((match:any)=>/^周[一二三四五六日天]\d+/u.test(String(match.CC_ID||""))).map((match:any)=>[String(match.SOURCE_MATCH_ID||match.ID||""),match])).values()).slice(0,40);
    const reports = candidates.flatMap((match:any)=>{
      const externalMatchId = String(match.SOURCE_MATCH_ID||match.ID||"").trim();
      const displayId = String(match.CC_ID||"").trim();
      const home = String(match.HOST_NAME||"").trim(), away = String(match.GUEST_NAME||"").trim();
      const timeText = String(match.MATCH_TIME||"").trim();
      const validTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timeText);
      const kickoffAt = validTime ? timeText.replace(" ","T")+"+08:00" : "";
      const kickoff = Date.parse(kickoffAt);
      const reject=(reason:string)=>{unavailable.push({displayId,home,away,reason});return[]};
      if(!externalMatchId||!home||!away||!Number.isFinite(kickoff))return reject("外围赛事身份或开赛时间缺失");
      const issueStart=Date.parse(`${issue}T00:00:00+08:00`);
      if(kickoff<issueStart||kickoff>=issueStart+48*60*60*1000)return reject("外围赛事不属于当前批次日期");
      if(kickoff<=now)return[];
      const sourceCompanies=parsedCompanies(match,fetchedAt),companies=displayCompanies(sourceCompanies);
      const modelInput=inputSnapshot(sourceCompanies,decisionAt),dataQuality=assessPredictionInput(sourceCompanies,decisionAt);
      if(dataQuality.status!=="ready")return reject(dataQuality.reasons.join("；"));
      const modeled=predictionComputeCache.predict(modelInput,{}, {mode:"research",scope:`${issue}:${externalMatchId}`}),rawProbabilities:number[]=modeled.marketProbabilities;
      const totalRows=sourceCompanies.filter(row=>validAsianLine(row.total)&&row.total>0&&asianMarketTarget(row.overPrice,row.underPrice)!==null);
      const asianRows=sourceCompanies.filter(row=>validAsianLine(row.handicap)&&asianMarketTarget(row.homePrice,row.awayPrice)!==null);
      const totalLine=median(totalRows.map(row=>row.total));
      const handicap=median(asianRows.map(row=>row.handicap));
      const asianHomeTarget=median(asianRows.map(row=>deVigHongKong(row.homePrice,row.awayPrice)[0]));
      const firstHandicap=median(asianRows.map(row=>row.firstHandicap));
      const firstAsianHomeTarget=median(asianRows.map(row=>deVigHongKong(row.firstHomePrice,row.firstAwayPrice)[0]));
      const overTarget=median(totalRows.map(row=>deVigHongKong(row.overPrice,row.underPrice)[0]));
      const derived=deriveMarkets(modeled.fullScoreDistribution,null);
      const had=derived.hadProbabilities.map(point=>point.probability);
      const direction=["主胜","平局","客胜"][had.indexOf(Math.max(...had))];
      const spread=Math.max(...companies.map(row=>row.win))-Math.min(...companies.map(row=>row.win));
      return [{
        id:`external:${issue}:${externalMatchId}`,externalMatchId,externalDisplayId:displayId,
        sourceIssue:issue,researchOnly:true,officialMappingStatus:"unmatched",marketEligibility:{},
        league:String(match.LEAGUE_NAME_SIMPLY||""),kickoffAt,time:timeText,matchDate:timeText.slice(0,10),
        home,away,matchStatus:"research_only",isMock:false,sourceUpdatedAt:null,
        modelInput,modelParameters:{},dataQuality,sourceFetchedAt:fetchedAt,priceDiagnostics:modeled.priceDiagnostics,
        companies,marketProbabilities:rawProbabilities.map(value=>value*100),
        probabilities:{home:had[0],draw:had[1],away:had[2]},
        consensus:{handicap,totalLine,agreement:companies.length===3&&spread<0.3&&modeled.fitError<0.03?"较一致":"有分歧"},
        marketSignal:{
          direction,strength:0,probabilityShifts:[0,0,0],fairOdds:had.map(value=>value>0?100/value:0),
          hadEv:[],hhadEv:[],evThreshold:EV_THRESHOLD,institutionAction:"外围盘口仅供研究",handicapExpectation:"不代表竞彩固定让球",firstHandicap,handicapChange:handicap-firstHandicap,
          narrative:"仅根据外围欧赔、亚洲盘和大小球建模；竞彩赛程、赔率、让球值及销售资格均未核验。",
          officialOdds:[],officialHandicap:"",officialHhadOdds:[],officialHhadFair:[],modeledHhad:[],hhadAvailable:false,
          modeledTotalGoals:derived.totalGoalProbabilities.map(point=>point.probability),modeledHalfFull:modeled.halfFullProbabilities,
          asianHomeProbability:asianHomeTarget*100,asianAwayProbability:(1-asianHomeTarget)*100,asianMovement:(asianHomeTarget-firstAsianHomeTarget)*100,
          overProbability:overTarget*100,fitAgreement:modeled.fitError<0.03?"外围盘口较一致":"外围盘口有分歧",
          handicapMeaning:"外围亚洲盘仅供研究；没有官方让球值，不生成体彩让球结论。"
        },
        expectedGoals:{home:modeled.expectedGoals[0],away:modeled.expectedGoals[1]},
        scores:modeled.scores,fullScoreDistribution:modeled.fullScoreDistribution,
        hadProbabilities:derived.hadProbabilities,totalGoalProbabilities:derived.totalGoalProbabilities,
        missingCompanies:COMPANY_IDS.filter(id=>!companies.some(row=>row.companyId===id))
      }];
    });
    const inputSnapshotId=`research-input-${predictionHash(reports.map(report=>({externalMatchId:report.externalMatchId,kickoffAt:report.kickoffAt,companies:report.companies})))}`;
    const version={predictionId:`research-${predictionHash({inputSnapshotId,fetchedAt})}`,inputSnapshotId,baseModelVersion:`${PREDICTION_PIPELINE_VERSION}-research`,calibrationVersion:"research-uncalibrated",generatedAt:fetchedAt};
    return Response.json({mode:"research-only",issue,version,reports:reports.map(report=>({...report,predictionId:version.predictionId,inputSnapshotId,baseModelVersion:version.baseModelVersion,calibrationVersion:version.calibrationVersion,predictionGeneratedAt:fetchedAt})),unavailable,fetchedAt,sourceUrl:SOURCE_URL,methodology:"仅使用外围三家公司欧赔、亚洲盘与大小球；不含竞彩官方赔率、固定让球值、销售状态或投注资格。该研究版本不进入正式推荐与复盘。"}, {headers:{"Cache-Control":"no-store"}});
  } catch(error) {
    return Response.json({error:error instanceof Error?error.message:"外围赛事读取失败",mode:"research-only"},{status:502,headers:{"Cache-Control":"no-store"}});
  }
}
