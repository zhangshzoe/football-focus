/* eslint-disable @typescript-eslint/no-explicit-any */
import {createBasePredictionVersion,deriveMarkets,predictionHash} from "../../prediction-version";
import {getPublishedCalibration} from "../../calibration-service";
import {TEAM_ALIAS_VERSION,teamIdentity} from "../../team-identity.js";
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
const SOURCE_URL = "https://plzx.zgzcw.com/";
const DATA_URL = "https://plzx.zgzcw.com/odds/oyzs_ajax.action";
const EV_THRESHOLD = 0.05;
const DEFAULT_FIRST_HALF_GOAL_SHARE = 0.45;
const TOTAL_GOAL_LABELS = ["0球", "1球", "2球", "3球", "4球", "5球", "6球", "7+球"];
const HALF_FULL_LABELS = ["胜胜", "胜平", "胜负", "平胜", "平平", "平负", "负胜", "负平", "负负"];
const oddsCache = new Map<string,{expiresAt:number;data:any[]}>();
const oddsRequests = new Map<string,Promise<any[]>>();
let oddsDataFetchedAt="";
const numeric = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

async function fetchCompanyOdds(issue: string, forceRefresh = false) {
  if(forceRefresh)oddsCache.delete(issue);
  const cached=oddsCache.get(issue);if(cached&&cached.expiresAt>Date.now())return cached.data;
  const pending=oddsRequests.get(issue);if(pending)return pending;
  const request = (async () => {
    const response = await fetch(DATA_URL, {
      method: "POST",
      headers: {"content-type": "application/x-www-form-urlencoded", referer: SOURCE_URL, "x-requested-with": "XMLHttpRequest"},
      body: new URLSearchParams({type: "", issue, date: "", companys: COMPANY_IDS.join(",")}),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`赔率源响应 ${response.status}`);
    const upstreamText = await response.text();
    if (/Access Verification|请求过于频繁|人机验证/.test(upstreamText)) throw new Error("足彩网触发访问频率保护，请等待几分钟后再刷新；页面不会使用虚构赔率替代");
    const data = JSON.parse(upstreamText);
    if (!Array.isArray(data)) throw new Error("足彩网赔率格式发生变化");
    oddsDataFetchedAt=new Date().toISOString();oddsCache.set(issue,{expiresAt:Date.now()+5*60*1000,data});
    return data;
  })();
  oddsRequests.set(issue,request);
  try { return await request; }
  finally { oddsRequests.delete(issue); }
}

function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeProbabilities(values:number[]){
 const valid=values.map(value=>Number.isFinite(value)&&value>0?value:0),total=valid.reduce((sum,value)=>sum+value,0);
 return total>0?valid.map(value=>value/total):valid.map(()=>1/Math.max(1,valid.length));
}

function temperatureCalibrate(values:number[],temperature:number){
 const safeTemperature=Number.isFinite(temperature)?Math.max(.7,Math.min(2.5,temperature)):1;
 return normalizeProbabilities(values.map(value=>Math.pow(Math.max(value,.0001),1/safeTemperature)));
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
  return [0, 1, 2].map((index) => median(probabilities.map((row) => row[index])) || 1 / 3);
}

function deVigDecimal(odds: number[]) {
  if (odds.length !== 3 || !odds.every((odd) => odd > 1)) return [];
  const raw = odds.map((odd) => 1 / odd);
  const total = raw.reduce((sum, value) => sum + value, 0);
  return raw.map((value) => value / total);
}

function deVigHongKong(homePrice: number, awayPrice: number) {
  if (!(homePrice > 0) || !(awayPrice > 0)) return [0.5, 0.5];
  const raw = [1 / (1 + homePrice), 1 / (1 + awayPrice)];
  const total = raw[0] + raw[1];
  return raw.map((value) => value / total);
}

function marketMedian(rows: number[][], fallback: number[]) {
  return fallback.map((value, index) => median(rows.map((row) => row[index])) || value);
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
  const level = abs <= 0.5 ? "赢1球级" : abs <= 1 ? "赢1～2球级" : abs <= 2 ? "赢2球级" : "赢3球级";
  if (line < 0) return `主队让${abs}，机构净胜球预期${level}`;
  if (line > 0) return `主队受让${abs}，机构倾向客队${level}`;
  return "平手盘，净胜球预期接近";
}

function interpretInstitutionAction(firstLine: number, line: number, firstHome: number, home: number, firstAway: number, away: number) {
  const lineDelta = line - firstLine;
  const homeMove = movementLabel(firstHome, home);
  const awayMove = movementLabel(firstAway, away);
  if (lineDelta < -0.005 && homeMove === "降赔") return "让球加深+主队降赔，主队获得强支持";
  if (lineDelta > 0.005 && awayMove === "降赔") return "主队受让加深+客队降赔，客队获得强支持";
  if (lineDelta < -0.005 && homeMove === "升赔") return "让球加深但主队升赔，盘口与赔付信号分歧";
  if (lineDelta > 0.005 && awayMove === "升赔") return "受让加深但客队升赔，盘口与赔付信号分歧";
  return `${lineDelta < -0.005 ? "让球加深" : lineDelta > 0.005 ? "受让加深" : "盘口深度持平"}；主队${homeMove}、客队${awayMove}`;
}

function expectedValue(probabilities: number[], odds: number[]) {
  if (!Array.isArray(odds) || odds.length !== probabilities.length) return [];
  return odds.map((odd, index) => odd > 1 ? probabilities[index] * odd - 1 : Number.NaN);
}

function poisson(lambda: number, goals: number) {
  let factorial = 1;
  for (let index = 2; index <= goals; index += 1) factorial *= index;
  return Math.exp(-lambda) * Math.pow(lambda, goals) / factorial;
}

function resultLabel(home: number, away: number) {
  return home > away ? "胜" : home === away ? "平" : "负";
}

function tempoScales(dispersion:number){
 const spread=Math.max(0,Math.min(.28,Math.sqrt(Math.max(0,dispersion-1))*.32));
 return spread>0.005?[{scale:1-spread,weight:.2},{scale:1,weight:.6},{scale:1+spread,weight:.2}]:[{scale:1,weight:1}];
}

function dixonColesTau(homeGoals:number,awayGoals:number,homeLambda:number,awayLambda:number,rho:number){
 if(homeGoals===0&&awayGoals===0)return 1-homeLambda*awayLambda*rho;
 if(homeGoals===0&&awayGoals===1)return 1+homeLambda*rho;
 if(homeGoals===1&&awayGoals===0)return 1+awayLambda*rho;
 if(homeGoals===1&&awayGoals===1)return 1-rho;
 return 1;
}

function jointScoreProbability(homeLambda:number,awayLambda:number,homeGoals:number,awayGoals:number,dispersion:number,lowScoreRho=0){
 return tempoScales(dispersion).reduce((sum,state)=>{const scaledHome=homeLambda*state.scale,scaledAway=awayLambda*state.scale,tau=Math.max(.05,dixonColesTau(homeGoals,awayGoals,scaledHome,scaledAway,lowScoreRho));return sum+state.weight*poisson(scaledHome,homeGoals)*poisson(scaledAway,awayGoals)*tau},0);
}

function totalGoalProbabilities(homeLambda: number, awayLambda: number,dispersion:number) {
  const lambda = homeLambda + awayLambda;
  const firstSeven = Array.from({length: 7}, (_, goals) => tempoScales(dispersion).reduce((sum,state)=>sum+state.weight*poisson(lambda*state.scale,goals),0));
  return [...firstSeven, Math.max(0, 1 - firstSeven.reduce((sum, value) => sum + value, 0))].map((value) => value * 100);
}

// 将全场进球拆成独立的上、下半场泊松增量，确保半全场与同一套预期进球一致。
function halfFullProbabilities(homeLambda: number, awayLambda: number,firstHalfGoalShare:number,dispersion:number) {
  const values = new Array(HALF_FULL_LABELS.length).fill(0) as number[];
  for(const state of tempoScales(dispersion)){
   const halfHomeLambda = homeLambda * firstHalfGoalShare*state.scale;
   const halfAwayLambda = awayLambda * firstHalfGoalShare*state.scale;
   const secondHomeLambda = homeLambda * (1 - firstHalfGoalShare)*state.scale;
   const secondAwayLambda = awayLambda * (1 - firstHalfGoalShare)*state.scale;
   for (let halfHome = 0; halfHome <= 7; halfHome += 1) for (let halfAway = 0; halfAway <= 7; halfAway += 1) {
    const halfProbability = poisson(halfHomeLambda, halfHome) * poisson(halfAwayLambda, halfAway);
    for (let secondHome = 0; secondHome <= 7; secondHome += 1) for (let secondAway = 0; secondAway <= 7; secondAway += 1) {
     const label = `${resultLabel(halfHome, halfAway)}${resultLabel(halfHome + secondHome, halfAway + secondAway)}`;
     values[HALF_FULL_LABELS.indexOf(label)] += state.weight*halfProbability * poisson(secondHomeLambda, secondHome) * poisson(secondAwayLambda, secondAway);
    }
   }
  }
  const captured = values.reduce((sum, value) => sum + value, 0);
  return values.map((value) => captured > 0 ? value / captured * 100 : 0);
}

function modelScores(target: number[], totalLine: number, handicap: number, asianHomeTarget: number, overTarget: number, officialHandicap: number|null, hhadTarget: number[],calibration:CalibrationBucket|null) {
  let best = { home: 1.35, away: 1.1, error: Number.POSITIVE_INFINITY };
  const dispersion=calibration?.goalDispersion||1,lowScoreRho=calibration?.lowScoreRho||0,historyWeight=calibration?Math.min(.12,calibration.sampleSize/250):0;
  for (let home = 0.25; home <= 3.95; home += 0.05) {
    for (let away = 0.2; away <= 3.7; away += 0.05) {
      let homeWin = 0, draw = 0, awayWin = 0, asianHome = 0, over = 0, hhadHome = 0, hhadDraw = 0, hhadAway = 0;
      for (let h = 0; h <= 9; h += 1) for (let a = 0; a <= 9; a += 1) {
        const probability = jointScoreProbability(home,away,h,a,dispersion,lowScoreRho);
        if (h > a) homeWin += probability;
        else if (h === a) draw += probability;
        else awayWin += probability;
        asianHome += probability / (1 + Math.exp(-6 * (h - a + handicap)));
        over += probability / (1 + Math.exp(-6 * (h + a - totalLine)));
        if(officialHandicap!==null){const adjusted = h - a + officialHandicap;if (adjusted > 0) hhadHome += probability;else if (adjusted === 0) hhadDraw += probability;else hhadAway += probability}
      }
      const marketError = (Math.pow(homeWin - target[0], 2) + Math.pow(draw - target[1], 2) + Math.pow(awayWin - target[2], 2)) * 0.48;
      const asianError = Number.isFinite(handicap) ? Math.pow(asianHome - asianHomeTarget, 2) * 0.30 : 0;
      const totalError = totalLine > 0 ? Math.pow(over - overTarget, 2) * 0.18 : 0;
      const hhadError = officialHandicap!==null&&hhadTarget.length === 3 ? (Math.pow(hhadHome - hhadTarget[0], 2) + Math.pow(hhadDraw - hhadTarget[1], 2) + Math.pow(hhadAway - hhadTarget[2], 2)) * 0.38 : 0;
      const lineError = Number.isFinite(handicap) ? Math.pow((home - away + handicap * 0.82) / 3, 2) * 0.06 : 0;
      const historyGoalError=calibration?Math.pow((home+away-calibration.meanTotalGoals)/3,2)*historyWeight:0;
      const error = marketError + asianError + totalError + hhadError + lineError+historyGoalError;
      if (error < best.error) best = {home, away, error};
    }
  }
  const scores: Array<{score: string; probability: number}> = [];
  for (let home = 0; home <= 7; home += 1) for (let away = 0; away <= 7; away += 1) {
    scores.push({score: `${home}:${away}`, probability: jointScoreProbability(best.home,best.away,home,away,dispersion,lowScoreRho) * 100});
  }
  const fullScores = scores.sort((a, b) => b.probability - a.probability),fullMass=scores.reduce((sum,item)=>sum+item.probability,0),fullScoreDistribution=fullScores.map(item=>({...item,probability:fullMass>0?item.probability/fullMass*100:0}));
  const hhad = officialHandicap===null?[]:[0, 0, 0];
  const capturedProbability=fullScoreDistribution.reduce((sum,item)=>sum+item.probability/100,0);
  fullScoreDistribution.forEach((item) => {
    const [home, away] = item.score.split(":").map(Number);
    if(officialHandicap!==null){const adjusted = home - away + officialHandicap;hhad[adjusted > 0 ? 0 : adjusted === 0 ? 1 : 2] += item.probability / 100}
  });
  return {
    expectedGoals: [best.home, best.away],
    scores: fullScoreDistribution.slice(0, 4),fullScoreDistribution,
    hhadProbabilities: hhad.map((value) => capturedProbability>0?value/capturedProbability*100:0),
    totalGoalProbabilities: totalGoalProbabilities(best.home, best.away,dispersion),
    halfFullProbabilities: halfFullProbabilities(best.home, best.away,calibration?.firstHalfGoalShare||DEFAULT_FIRST_HALF_GOAL_SHARE,dispersion),
    fitError: best.error,lowScoreRho,
  };
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
 const reversed=officialMatches.filter(item=>home&&away&&normalizedTeam(item.home,item.league)===away&&normalizedTeam(item.away,item.league)===home&&sameSchedule(item));
 const candidates=officialMatches.filter(item=>String(item.id||"")===String(external.CC_ID||"")||normalizedTeam(item.home,item.league)===home||normalizedTeam(item.away,item.league)===away||reversed.includes(item));
 const verified=candidates.filter(item=>sameTeams(item)&&sameSchedule(item));
 if(verified.length===1)return{official:verified[0],status:"verified",reason:`日期、主客队与开赛时间均已通过校验（球队别名版本 ${TEAM_ALIAS_VERSION}）`,candidateOfficialMatchIds:[]};
 const candidateOfficialMatchIds=candidates.map(item=>String(item.officialMatchId||item.matchId||"")).filter(Boolean);
 if(verified.length>1)return{official:null,status:"pending_verification",reason:"存在多场同队同时间赛事，无法唯一确认官方比赛",candidateOfficialMatchIds};
 if(reversed.length)return{official:null,status:"pending_verification",reason:"外围盘口的主客队顺序与官方赛程相反，暂停生成预测",candidateOfficialMatchIds};
 const reasons=[];if(!candidates.some(sameTeams))reasons.push("主客队名称尚未匹配");
 if(!candidates.some(item=>(datePart(item.kickoffAt)||datePart(item.matchDate)||datePart(item.time)||datePart(item.salesDate))===externalDate))reasons.push("比赛日期不一致");
 if(!externalClock)reasons.push("外围开赛时间缺失");else if(!candidates.some(item=>{const clock=clockPart(item.kickoffAt)||clockPart(item.time);return clock&&Math.abs(minutes(clock)-minutes(externalClock))<=45}))reasons.push("开赛时间不一致");
 return{official:null,status:"pending_verification",reason:reasons.join("、")||"无法唯一确认官方赛事",candidateOfficialMatchIds};
}
function nullableHandicap(value:unknown){const text=String(value??"").trim();if(!text)return null;const parsed=Number(text);return Number.isFinite(parsed)?parsed:null}

export async function POST(request: Request) {
  const input = await request.json().catch(() => null);
  const sportteryMatches: any[] = Array.isArray(input?.matches) ? input.matches.slice(0, 120) : [];
  const forceRefresh = input?.forceRefresh === true;
  const calibrationProfile = await getPublishedCalibration() as Partial<ModelCalibrationProfile> | null;
  const globalCalibration = calibrationProfile?.status==="validated"&&calibrationProfile?.trainingSampleSize&&calibrationProfile.trainingSampleSize>=20
    ? validCalibrationBucket(calibrationProfile.global)
    : null;
  const probabilityTemperature = calibrationProfile?.status==="validated"&&calibrationProfile?.calibrationSampleSize&&calibrationProfile.calibrationSampleSize>=6
    ? Math.max(.7, Math.min(2.5, numeric(calibrationProfile.probabilityTemperature) || 1))
    : 1;
  if (!sportteryMatches.length) return Response.json({reports:[],fetchedAt:new Date().toISOString(),sourceUrl:SOURCE_URL,methodology:"没有可确认的官方比赛，未执行赔率模型。"});
  try {
    const issue = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const issues=Array.from(new Set(sportteryMatches.map(match=>datePart(match.salesDate)).filter(Boolean)));if(!issues.length)issues.push(issue);
    const raw=Array.from(new Map((await Promise.all(issues.map(async saleIssue=>(await fetchCompanyOdds(saleIssue,forceRefresh)).map(match=>({...match,__issue:saleIssue}))))).flat().map(match=>[`${match.CC_ID||""}|${match.MATCH_ID||match.ID||""}`,match])).values());
    const pendingVerification:any[]=[];
    const reports = raw.filter((match) => String(match.CC_ID || "").includes("周")).map((match) => {
      const companies: CompanyOdds[] = (match.listOdds || []).filter((row: any) => COMPANY_IDS.includes(Number(row.SOURCE_COMPANY_ID))).map((row: any) => ({
        companyId: Number(row.SOURCE_COMPANY_ID), company: String(row.COMPANY_NAME),
        win: numeric(row.WIN), draw: numeric(row.SAME), lose: numeric(row.LOST),
        handicap: numeric(row.HANDICAP), homePrice: numeric(row.HOST), awayPrice: numeric(row.GUEST),
        total: numeric(row.DW_HANDICAP), overPrice: numeric(row.BIG), underPrice: numeric(row.SMALL),
        firstWin: numeric(row.FIRST_WIN), firstDraw: numeric(row.FIRST_SAME), firstLose: numeric(row.FIRST_LOST),
        firstHandicap: numeric(row.FIRST_HANDICAP), firstHomePrice: numeric(row.FIRST_HOST), firstAwayPrice: numeric(row.FIRST_GUEST),
        firstTotal: numeric(row.DW_FIRST_HANDICAP), firstOverPrice: numeric(row.FIRST_BIG), firstUnderPrice: numeric(row.FIRST_SMALL),
      }));
      const saleIssue=String(match.__issue||issue),mapping=verifyOfficialMapping(match,sportteryMatches,saleIssue),official=mapping.official;
      if (!official){pendingVerification.push({externalId:String(match.MATCH_ID||match.ID||""),displayId:String(match.CC_ID||""),matchDate:datePart(match.MATCH_TIME)||saleIssue,time:clockPart(match.MATCH_TIME),home:String(match.HOST_NAME||""),away:String(match.GUEST_NAME||""),mappingStatus:mapping.status,reason:mapping.reason,candidateOfficialMatchIds:mapping.candidateOfficialMatchIds});return null}
      const externalRows = companies.map((row) => deVigDecimal([row.win, row.draw, row.lose])).filter((row) => row.length === 3);
      const externalProbabilities = marketMedian(externalRows, [1 / 3, 1 / 3, 1 / 3]);
      const officialProbabilities = deVigDecimal(official?.odds || []);
      const rawProbabilities = normalizeProbabilities(officialProbabilities.length === 3 ? externalProbabilities.map((value, index) => value * 0.65 + officialProbabilities[index] * 0.35) : externalProbabilities);
      const probabilities = temperatureCalibrate(rawProbabilities, probabilityTemperature);
      const totalLine = median(companies.map((row) => row.total));
      const handicap = median(companies.map((row) => row.handicap));
      const asianHomeTarget = median(companies.map((row) => deVigHongKong(row.homePrice, row.awayPrice)[0])) || 0.5;
      const initialAsianHomeTarget = median(companies.map((row) => deVigHongKong(row.firstHomePrice, row.firstAwayPrice)[0])) || 0.5;
      const overTarget = median(companies.map((row) => deVigHongKong(row.overPrice, row.underPrice)[0])) || 0.5;
      const hhadEligibility=official?.marketEligibility?.["让球胜平负"],officialHandicap=hhadEligibility?.qualification==="qualified"?nullableHandicap(hhadEligibility.handicap??official?.handicap):null;
      const officialHhadOdds=hhadEligibility?.qualification==="qualified"&&officialHandicap!==null?(official?.hhadOdds||[]):[];
      const officialHhadFair = deVigDecimal(officialHhadOdds);
      const league = String(match.LEAGUE_NAME_SIMPLY || official?.league || "");
      const leagueCalibrationCandidate = calibrationProfile?.leagues?.[league];
      const leagueCalibration = leagueCalibrationCandidate && numeric(leagueCalibrationCandidate.sampleSize) >= 8
        ? validCalibrationBucket(leagueCalibrationCandidate)
        : null;
      const activeCalibration = leagueCalibration || globalCalibration;
      const modeled = modelScores(probabilities, totalLine, handicap, asianHomeTarget, overTarget, officialHandicap, officialHhadFair, activeCalibration);
      const derived=deriveMarkets(modeled.fullScoreDistribution,officialHandicap),finalProbabilities=derived.hadProbabilities.map(point=>point.probability/100),finalHhad=derived.hhadProbabilities?.map(point=>point.probability)||[],finalGoals=derived.totalGoalProbabilities.map(point=>point.probability);
      const initialProbabilities = normalized1x2(companies.map(row=>({...row,win:row.firstWin,draw:row.firstDraw,lose:row.firstLose})), []);
      const shifts = probabilities.map((value,index)=>(value-initialProbabilities[index])*100);
      const asianMovement = (asianHomeTarget - initialAsianHomeTarget) * 100;
      const combinedDirectionScores = [shifts[0] + asianMovement * 0.45, shifts[1], shifts[2] - asianMovement * 0.45];
      const movementDirectionIndex = combinedDirectionScores.indexOf(Math.max(...combinedDirectionScores));
      const directions = ["主队方向","平局方向","客队方向"];
      const directionIndex = finalProbabilities.indexOf(Math.max(...finalProbabilities));
      const firstHandicap = median(companies.map(row=>row.firstHandicap));
      const handicapChange = handicap-firstHandicap;
      const fairOdds = finalProbabilities.map(value=>value>0?1/value:0);
      const hadEv = expectedValue(finalProbabilities, official?.odds || []);
      const hhadEv = officialHandicap===null?[]:expectedValue(finalHhad.map(value => value / 100), officialHhadOdds);
      const directionStrength = Math.max(...combinedDirectionScores);
      const fitAgreement = modeled.fitError < 0.012 ? "多盘口较一致" : modeled.fitError < 0.03 ? "部分一致" : "盘口分歧较大";
      const institutionAction = interpretInstitutionAction(firstHandicap, handicap, median(companies.map(row=>row.firstHomePrice)), median(companies.map(row=>row.homePrice)), median(companies.map(row=>row.firstAwayPrice)), median(companies.map(row=>row.awayPrice)));
      const expectation = handicapExpectation(handicap);
      const calibrationNarrative = activeCalibration ? `已使用 ${leagueCalibration ? league : "全局"} 历史样本 ${activeCalibration.sampleSize} 场，对概率锐度、总进球离散度、低比分相关性和半场进球占比作小幅校准。` : "历史有效样本不足，本场保持盘口模型基线；低比分相关修正保持影子状态，不以短样本强行启用。";
      const narrative = `当前绝对概率最高为${directions[directionIndex]}；变盘相对偏向${directions[movementDirectionIndex]}。${institutionAction}。该变盘信号表示相对强弱变化，不等同于赛果概率最高项；欧赔变化 ${Math.abs(shifts[movementDirectionIndex]).toFixed(1)} 个百分点，亚盘主队侧水位概率变化 ${asianMovement>=0?"+":""}${asianMovement.toFixed(1)} 个百分点。${expectation}；当前结论为“${fitAgreement}”。${calibrationNarrative}`;
      const spread = Math.max(...companies.map((row) => row.win), 0) - Math.min(...companies.map((row) => row.win), Number.POSITIVE_INFINITY);
      return {
        id: String(official.id),externalDisplayId:String(match.CC_ID),officialMatchId:String(official.officialMatchId||official.matchId),salesDate:String(official.salesDate||official.matchDate||""),kickoffAt:String(official.kickoffAt||""),homeTeamId:String(official.homeTeamId||""),awayTeamId:String(official.awayTeamId||""),homeTeamCode:String(official.homeTeamCode||""),awayTeamCode:String(official.awayTeamCode||""),officialMappingStatus:"verified",mappingReason:mapping.reason,marketEligibility:official.marketEligibility||{},league,
        time: String(official?.matchDate&&official?.time?`${official.matchDate} ${official.time}`:official?.kickoffAt||official?.time||match.MATCH_TIME||""), matchDate: String(official?.matchDate || match.MATCH_TIME || ""), home: String(official.home), away: String(official.away), matchStatus: official?.matchStatus || "", isMock: Boolean(official?.isMock), sourceUpdatedAt: official?.updatedAt || "",
        companies, marketProbabilities:rawProbabilities.map(value=>value*100),probabilities: {home: finalProbabilities[0] * 100, draw: finalProbabilities[1] * 100, away: finalProbabilities[2] * 100},
        consensus: {handicap, totalLine, agreement: companies.length === 3 && spread < 0.3 && modeled.fitError < 0.03 ? "较一致" : "有分歧"},
        marketSignal: {direction:directions[directionIndex],movementDirection:directions[movementDirectionIndex],strength:directionStrength,probabilityShifts:shifts,fairOdds,hadEv,hhadEv,evThreshold:EV_THRESHOLD,institutionAction,handicapExpectation:expectation,firstHandicap,handicapChange,narrative,officialOdds:official?.odds||[],officialHandicap:officialHandicap===null?"":String(officialHandicap),officialHhadOdds,officialHhadFair:officialHhadFair.map(value=>value*100),modeledHhad:finalHhad,hhadAvailable:officialHandicap!==null&&officialHhadOdds.length===3,modeledTotalGoals:finalGoals,totalGoalLabels:TOTAL_GOAL_LABELS,modeledHalfFull:modeled.halfFullProbabilities,halfFullLabels:HALF_FULL_LABELS,asianHomeProbability:asianHomeTarget*100,asianAwayProbability:(1-asianHomeTarget)*100,asianMovement,overProbability:overTarget*100,fitAgreement,handicapMeaning:handicapMeaning(handicap,officialHandicap),rawProbabilities:rawProbabilities.map(value=>value*100),calibrationSampleSize:activeCalibration?.sampleSize||0,probabilityTemperature,historicalMeanTotalGoals:activeCalibration?.meanTotalGoals,goalDispersion:activeCalibration?.goalDispersion,firstHalfGoalShare:activeCalibration?.firstHalfGoalShare,lowScoreRho:modeled.lowScoreRho},
        expectedGoals: {home: modeled.expectedGoals[0], away: modeled.expectedGoals[1]}, scores: modeled.scores,fullScoreDistribution:modeled.fullScoreDistribution,
        missingCompanies: COMPANY_IDS.filter((id) => !companies.some((row) => row.companyId === id)),
      };
    }).filter(Boolean);
    const generatedAt=oddsDataFetchedAt||new Date().toISOString(),calibrationVersion=globalCalibration?String(calibrationProfile?.profileId||`cal-${predictionHash(calibrationProfile)}`):"cal-none",version=createBasePredictionVersion(reports,calibrationVersion,generatedAt),versionedReports=reports.map(report=>({...report,predictionId:version.predictionId,inputSnapshotId:version.inputSnapshotId,baseModelVersion:version.baseModelVersion,calibrationVersion:version.calibrationVersion,predictionGeneratedAt:version.generatedAt}));
    const coveredIds=new Set(reports.map((report:any)=>String(report.officialMatchId||"")));
    const unavailableOfficialMatches=sportteryMatches.filter(match=>!coveredIds.has(String(match.officialMatchId||match.matchId||""))).map(match=>{
      const officialMatchId=String(match.officialMatchId||match.matchId||"");
      const related=pendingVerification.filter(record=>record.candidateOfficialMatchIds?.includes(officialMatchId));
      const reasons=Array.from(new Set(related.map(record=>record.reason)));
      return{id:match.id,officialMatchId,salesDate:match.salesDate,kickoffAt:match.kickoffAt,matchDate:match.matchDate,time:match.time,league:match.league,home:match.home,away:match.away,reason:reasons.join("；")||"外围盘口尚未提供可核验的本场数据"};
    });
    const coverage={officialMatches:sportteryMatches.length,predictedMatches:versionedReports.length,unavailableMatches:unavailableOfficialMatches.length,pendingExternalMappings:pendingVerification.length};
    return Response.json({predictionId:version.predictionId,version,reports:versionedReports,pendingVerification,unavailableOfficialMatches,coverage, fetchedAt: generatedAt, sourceUrl: SOURCE_URL, methodology: `覆盖 ${coverage.predictedMatches}/${coverage.officialMatches} 场官方赛事；${coverage.unavailableMatches} 场因外围盘口缺失或身份未通过校验而不生成概率，另有 ${coverage.pendingExternalMappings} 条外围记录待核验。多盘口交叉校准：三家公司欧赔初盘/即盘、亚洲让球水位、大小球与体彩胜平负/固定让球盘共同约束预期进球；${globalCalibration ? `使用服务端校准版本 ${calibrationProfile?.profileId}，其参数只由训练/校准区间确定，并已保留未来测试区间；低比分相关参数 ${globalCalibration.lowScoreRho||0}` : "尚无通过未来测试门槛的服务端校准版本，保持盘口模型基线，Dixon–Coles 低比分修正处于影子验证"}；外围赛事仅在日期、主客队与开赛时间全部通过官方校验后进入可执行预测，盘口冲突会降低一致度。`});
  } catch (error) {
    return Response.json({error: error instanceof Error ? error.message : "赔率数据读取失败"}, {status: 502});
  }
}
