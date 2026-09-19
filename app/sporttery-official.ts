/* eslint-disable @typescript-eslint/no-explicit-any */

export const SPORTTERY_SOURCE_URL="https://webapi.sporttery.cn/gateway/uniform/football/getMatchCalculatorV1.qry";
export const SPORTTERY_POOLS=["HAD","HHAD","CRS","TTG","HAFU"] as const;
export type SportteryPool=(typeof SPORTTERY_POOLS)[number];

type MarketState="available"|"unavailable"|"failed";
const marketByPool={HAD:"胜平负",HHAD:"让球胜平负",CRS:"比分",TTG:"总进球数",HAFU:"半全场"} as const;
const maxPassByPool:Record<SportteryPool,number>={HAD:8,HHAD:8,CRS:4,TTG:6,HAFU:4};
const SPORTTERY_RULE_VERSION="sporttery-football-2026-09";
const scoreKeys=["s01s00","s02s00","s02s01","s03s00","s03s01","s03s02","s04s00","s04s01","s04s02","s05s00","s05s01","s05s02","s1sh","s00s00","s01s01","s02s02","s03s03","s1sd","s00s01","s00s02","s01s02","s00s03","s01s03","s02s03","s00s04","s01s04","s02s04","s00s05","s01s05","s02s05","s1sa"];
const halfFullKeys=["hh","hd","ha","dh","dd","da","ah","ad","aa"];

function oddsOrNull(source:Record<string,unknown>|undefined,keys:string[]){
 const values=keys.map(key=>Number(source?.[key])).map(value=>Number.isFinite(value)&&value>0?value:0);
 return values.some(value=>value>0)?values:null;
}

const rowsOf=(payload:any)=>Array.isArray(payload?.value?.matchInfoList)?payload.value.matchInfoList.flatMap((group:any)=>group.subMatchList||[]):[];

const isoShanghai=(date:unknown,time:unknown)=>{
 const day=String(date||"").match(/\d{4}-\d{2}-\d{2}/)?.[0]||"",clock=String(time||"").match(/\d{2}:\d{2}(?::\d{2})?/)?.[0]||"";
 return day&&clock?`${day}T${clock.length===5?`${clock}:00`:clock}+08:00`:null;
};

const poolRule=(row:any,pool:SportteryPool,hasOdds:boolean)=>{
 const raw=Array.isArray(row?.poolList)?row.poolList.find((item:any)=>String(item.poolCode).toUpperCase()===pool):undefined;
 const supportsSingle=Number(raw?.bettingSingle??row?.bettingSingle)===1;
 const supportsAllUp=Number(raw?.bettingAllup??raw?.bettingAllUp??row?.bettingAllUp)===1;
 const maxPass=maxPassByPool[pool],allowedPassCounts=[...(supportsSingle?[1]:[]),...(supportsAllUp?Array.from({length:maxPass-1},(_,index)=>index+2):[])];
 const salesStatus=String(raw?.poolStatus||row?.matchStatus||"");
 return{marketCode:pool,handicap:pool==="HHAD"&&hasOdds&&String(row?.hhad?.goalLine||"").trim()?String(row.hhad.goalLine):null,salesStatus,supportsSingle,allowedPassCounts,cutoffAt:isoShanghai(raw?.poolCloseDate,raw?.poolCloseTime),ruleVersion:SPORTTERY_RULE_VERSION,qualification:hasOdds&&salesStatus.toLowerCase()==="selling"&&allowedPassCounts.length?"qualified":hasOdds?"not_selling":"unavailable"};
};

const errorMessage=(error:unknown)=>error instanceof Error?(error.name==="AbortError"?"请求超时":error.message):"读取失败";

async function fetchPool(pool:SportteryPool,timeoutMs:number,serverHeaders:boolean){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const url=`${SPORTTERY_SOURCE_URL}?channel=0005&poolCode=${pool}&_=${Date.now()}`;
  const headers:HeadersInit=serverHeaders?{Referer:"https://www.sporttery.cn/","User-Agent":"Mozilla/5.0 (compatible; Personal-Football-Lab/1.0)",Accept:"application/json"}:{Accept:"application/json"};
  const response=await fetch(url,{cache:"no-store",signal:controller.signal,headers,credentials:"omit",mode:"cors"});
  if(!response.ok)throw new Error(`返回 ${response.status}`);
  const contentType=response.headers.get("content-type")||"",raw=await response.text();
  let json:any;
  try{json=JSON.parse(raw)}catch{throw new Error(`返回了非 JSON 数据${contentType?`（${contentType}）`:""}`)}
  if(!json?.success)throw new Error(json?.errorMessage||"数据不可用");
  return json;
 }finally{clearTimeout(timer)}
}

export type SportteryData={
 source:string;
 sourcePage:string;
 fetchedAt:string;
 upstreamUpdatedAt:string;
 poolStatus:Record<SportteryPool,{status:"success"|"failed";matchCount:number;error?:string}>;
 matches:any[];
 repairMode:boolean;
 attempts:number;
 deliveryMode:"server"|"browser-direct";
};

export async function fetchOfficialSporttery(options:{repair?:boolean;serverHeaders?:boolean;timeoutMs?:number}={}):Promise<SportteryData>{
 const repair=Boolean(options.repair),attempts=repair?2:1,timeoutMs=options.timeoutMs||12000;
 const collected=Object.fromEntries(SPORTTERY_POOLS.map(pool=>[pool,[]])) as Record<SportteryPool,any[]>;
 const errors=Object.fromEntries(SPORTTERY_POOLS.map(pool=>[pool,[]])) as Record<SportteryPool,string[]>;
 for(let attempt=0;attempt<attempts;attempt++){
  const settled=await Promise.allSettled(SPORTTERY_POOLS.map(pool=>fetchPool(pool,timeoutMs,Boolean(options.serverHeaders))));
  SPORTTERY_POOLS.forEach((pool,index)=>{const result=settled[index];if(result.status==="fulfilled")collected[pool].push(result.value);else errors[pool].push(errorMessage(result.reason))});
 }
 const byPool={} as Partial<Record<SportteryPool,any>>;
 const poolStatus={} as SportteryData["poolStatus"];
 SPORTTERY_POOLS.forEach(pool=>{
  const payloads=collected[pool],rows=new Map<string,any>();
  payloads.forEach(payload=>rowsOf(payload).forEach((row:any)=>rows.set(String(row.matchId),row)));
  if(payloads.length){const latest=payloads.at(-1);byPool[pool]={...latest,value:{...latest.value,matchInfoList:[{subMatchList:Array.from(rows.values())}]}};poolStatus[pool]={status:"success",matchCount:rows.size}}
  else poolStatus[pool]={status:"failed",matchCount:0,error:errors[pool].at(-1)||"读取失败"};
 });
 if(!SPORTTERY_POOLS.some(pool=>poolStatus[pool].status==="success"))throw new Error(`竞彩网五个玩法均读取失败：${SPORTTERY_POOLS.map(pool=>`${pool} ${poolStatus[pool].error||"失败"}`).join("；")}`);
 const maps=Object.fromEntries(SPORTTERY_POOLS.map(pool=>[pool,new Map(rowsOf(byPool[pool]).map((row:any)=>[String(row.matchId),row]))])) as Record<SportteryPool,Map<string,any>>;
 const ids=new Set<string>();SPORTTERY_POOLS.forEach(pool=>maps[pool].forEach((_row,id)=>ids.add(id)));
 const matches=Array.from(ids).map(matchId=>{
  const had=maps.HAD.get(matchId),hhad=maps.HHAD.get(matchId),crs=maps.CRS.get(matchId),ttg=maps.TTG.get(matchId),hafu=maps.HAFU.get(matchId),row=had||hhad||crs||ttg||hafu;
  const values={"胜平负":oddsOrNull(had?.had,["h","d","a"]),"让球胜平负":oddsOrNull(hhad?.hhad,["h","d","a"]),"比分":oddsOrNull(crs?.crs,scoreKeys),"总进球数":oddsOrNull(ttg?.ttg,["s0","s1","s2","s3","s4","s5","s6","s7"]),"半全场":oddsOrNull(hafu?.hafu,halfFullKeys)};
  const marketStatus={} as Record<string,MarketState>,marketEligibility={} as Record<string,ReturnType<typeof poolRule>>;
  SPORTTERY_POOLS.forEach(pool=>{const market=marketByPool[pool];marketStatus[market]=poolStatus[pool].status==="failed"?"failed":values[market]?"available":"unavailable"});
  SPORTTERY_POOLS.forEach(pool=>{const market=marketByPool[pool],marketRow=maps[pool].get(matchId);marketEligibility[market]=poolRule(marketRow||row,pool,Boolean(values[market]));if(poolStatus[pool].status==="failed")marketEligibility[market]={...marketEligibility[market],qualification:"unavailable",salesStatus:"failed"}});
  const updates=[had?.had,hhad?.hhad,crs?.crs,ttg?.ttg,hafu?.hafu].filter(Boolean).map((value:any)=>`${value.updateDate||""} ${value.updateTime||""}`.trim()).filter(Boolean).sort();
  const salesDate=row.businessDate||row.matchDate||"",kickoffAt=isoShanghai(row.matchDate,row.matchTime)||isoShanghai(salesDate,row.matchTime);
  return{id:row.matchNumStr,matchId:String(row.matchId),officialMatchId:String(row.matchId),salesDate,kickoffAt,league:row.leagueAbbName||row.leagueAllName,time:row.matchTime,matchDate:row.matchDate,home:row.homeTeamAbbName||row.homeTeamAllName,away:row.awayTeamAbbName||row.awayTeamAllName,homeTeamId:String(row.homeTeamId||""),awayTeamId:String(row.awayTeamId||""),homeTeamCode:String(row.homeTeamCode||""),awayTeamCode:String(row.awayTeamCode||""),homeRank:row.homeRank||"",awayRank:row.awayRank||"",sellStatus:row.sellStatus,matchStatus:row.matchStatus||"",remark:row.remark||"",handicap:marketEligibility["让球胜平负"].handicap,odds:values["胜平负"],marketOdds:values,marketStatus,marketEligibility,ruleVersion:SPORTTERY_RULE_VERSION,updatedAt:updates.at(-1)||"",form:[],tag:row.matchStatus==="Selling"?"销售中":row.remark||"已截止",risk:"赔率会随官方发布更新，提交前请再次核对竞彩网。"};
 }).filter(match=>match.id&&match.matchId&&match.home&&match.away);
 const upstreamUpdatedAt=SPORTTERY_POOLS.flatMap(pool=>[String(byPool[pool]?.value?.lastUpdateTime||"")]).filter(Boolean).sort().at(-1)||"";
 return{source:"中国体育彩票·竞彩网",sourcePage:"https://www.sporttery.cn/",fetchedAt:new Date().toISOString(),upstreamUpdatedAt,poolStatus,matches,repairMode:repair,attempts,deliveryMode:options.serverHeaders?"server":"browser-direct"};
}
