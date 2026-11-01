const POOLS=['HAD','HHAD','CRS','TTG','HAFU'];
const MAX_AGE_MS=5*60*1000;
function timestamp(value){
 if(typeof value!=='string'||!value.trim())return NaN;
 const s=value.trim().replace(' ','T');
 return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(s)?s:s+'+08:00');
}
function poolFacts(status={}){
 return Object.fromEntries(POOLS.map(pool=>{
  const row=status[pool],error=typeof row?.error==='string'?row.error:null;
  return [pool,{status:row?.status||'unknown',matchCount:Number.isInteger(row?.matchCount)?row.matchCount:null,error,upstreamUpdatedAt:typeof row?.upstreamUpdatedAt==='string'?row.upstreamUpdatedAt:null,httpCodes:error?[...new Set([...error.matchAll(/返回\s+(\d{3})/g)].map(x=>Number(x[1])))]:[]}];
 }));
}
export async function probeOfficialSource(readOfficialSource){
 const startedAt=new Date().toISOString();
 const provenance={source:'中国体育彩票·竞彩网',sourcePage:'https://www.sporttery.cn/',adapter:'existing-site-official-reader',repair:false,mobileFallback:false,persisted:false,predictionGenerated:false};
 if(typeof readOfficialSource!=='function')throw new Error('SOURCE_READER_UNAVAILABLE');
 try {
  const data=await readOfficialSource(),observedAt=new Date().toISOString(),now=Date.parse(observedAt);
  const fetched=timestamp(data.fetchedAt),upstream=timestamp(data.upstreamUpdatedAt);
  const age=value=>Number.isFinite(value)?now-value:null;
  const fresh=value=>Number.isFinite(value)&&now-value>=0&&now-value<=MAX_AGE_MS;
  const pools=poolFacts(data.poolStatus),allPools=POOLS.every(p=>pools[p].status==='success');
  const matchCount=Array.isArray(data.matches)?data.matches.length:null;
  const fetchedFresh=fresh(fetched),upstreamFresh=fresh(upstream);
  const poolFreshness=Object.fromEntries(POOLS.map(p=>[p,{valid:pools[p].status==='success'&&fresh(timestamp(pools[p].upstreamUpdatedAt)),ageMs:age(timestamp(pools[p].upstreamUpdatedAt))}]));
  const allPoolsFresh=POOLS.every(p=>poolFreshness[p].valid);
  const valid=allPools&&matchCount>0&&fetchedFresh&&upstreamFresh&&allPoolsFresh;
  return {...provenance,startedAt,observedAt,status:valid?'source-read-verified':!allPools?'partial':matchCount===0?'empty':'stale-or-unknown',sourceReady:valid,sourceAccessVerified:POOLS.some(p=>pools[p].status==='success'),responseReadable:true,completePredictionPipelineVerified:false,fetchedAt:data.fetchedAt||null,upstreamUpdatedAt:data.upstreamUpdatedAt||null,deliveryMode:data.deliveryMode||null,pools,matchCount,freshness:{valid,fetchedFresh,upstreamFresh,allPoolsFresh,poolFreshness,fetchedAgeMs:age(fetched),upstreamAgeMs:age(upstream),maxAgeMs:MAX_AGE_MS},productionEnabled:false};
 }catch(error){
  const detail=error instanceof Error?error.message:'OFFICIAL_FETCH_FAILED';
  const pools=poolFacts(error?.poolStatus),codes=[...new Set(Object.values(pools).flatMap(p=>p.httpCodes))];
  return {...provenance,startedAt,observedAt:new Date().toISOString(),status:'failed',sourceReady:false,sourceAccessVerified:false,responseReadable:false,completePredictionPipelineVerified:false,code:codes.some(c=>[401,403,429,567].includes(c))?'OFFICIAL_ACCESS_BLOCKED':'OFFICIAL_FETCH_FAILED',error:detail,httpCodes:codes,pools,fetchedAt:null,upstreamUpdatedAt:null,matchCount:null,freshness:{valid:false,fetchedFresh:false,upstreamFresh:false,maxAgeMs:MAX_AGE_MS},productionEnabled:false};
 }
}
