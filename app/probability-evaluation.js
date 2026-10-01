import {deVig} from "./asian-market.js";
import {MARKET_META} from "./purchase-plan-engine.js";
export const HAD_LABELS=["胜","平","负"];
export const EXACT_SCORE_LABELS=Array.from({length:169},(_,i)=>`${Math.floor(i/13)}:${i%13}`);
export function completeDistribution(points,labels,normalizeLabel=value=>String(value)){
 if(!Array.isArray(points)||points.length!==labels.length)return null;
 const values=new Map();
 for(const point of points){const label=normalizeLabel(point?.score),value=point?.probability;if(values.has(label)||typeof value!=="number"||!Number.isFinite(value)||value<0||value>100||!labels.includes(label))return null;values.set(label,value/100);}
 const vector=labels.map(label=>values.get(label)),sum=vector.reduce((a,b)=>a+b,0);
 return vector.some(value=>value===undefined)||Math.abs(sum-1)>.005?null:vector.map(value=>value/sum);
}
export function scoreProbability(vector,index,ordered=false){
 if(!vector||index<0||index>=vector.length)return null;
 const brier=vector.reduce((sum,p,i)=>sum+(p-Number(i===index))**2,0),logLoss=-Math.log(Math.max(1e-12,vector[index]));
 let rps=null;
 if(ordered){let cdf=0;rps=0;for(let i=0;i<vector.length-1;i++){cdf+=vector[i];rps+=(cdf-Number(index<=i))**2;}rps/=vector.length-1;}
 const rank=vector.map((p,i)=>({p,i})).sort((a,b)=>b.p-a.p||a.i-b.i).findIndex(item=>item.i===index)+1;
 return{vector,index,brier,logLoss,rps,rank};
}
export function summarizeProbability(observations){
 const rows=(observations||[]).filter(Boolean),sampleSize=rows.length;
 const mean=key=>sampleSize?rows.reduce((sum,r)=>sum+r[key],0)/sampleSize:null;
 const buckets=Array.from({length:5},(_,i)=>({range:`${i*20}–${(i+1)*20}%`,count:0,sum:0,hits:0}));
 rows.forEach(r=>r.vector.forEach((p,i)=>{const bucket=buckets[Math.min(4,Math.floor(p*5))];bucket.count++;bucket.sum+=p;bucket.hits+=Number(i===r.index);}));
 const reliability=buckets.map(b=>({range:b.range,count:b.count,meanProbability:b.count?b.sum/b.count:0,observedRate:b.count?b.hits/b.count:0})),count=reliability.reduce((n,b)=>n+b.count,0);
 return{sampleSize,brier:mean("brier"),logLoss:mean("logLoss"),rps:sampleSize&&rows.every(r=>r.rps!==null)?mean("rps"):null,
  hitRate:sampleSize?rows.filter(r=>r.rank===1).length/sampleSize:null,top1:sampleSize?rows.filter(r=>r.rank===1).length/sampleSize:null,top2:sampleSize?rows.filter(r=>r.rank<=2).length/sampleSize:null,top3:sampleSize?rows.filter(r=>r.rank<=3).length/sampleSize:null,
  ece:count?reliability.reduce((sum,b)=>sum+b.count*Math.abs(b.meanProbability-b.observedRate),0)/count:null,reliability};
}
export function frozenOfficialMarkets(input){
 const decision=Date.parse(input?.decisionAt||""),fetched=Date.parse(input?.official?.fetchedAt||"");
 if(!Number.isFinite(decision)||!Number.isFinite(fetched)||fetched>decision||decision-fetched>300000)return null;
 const official=input.official;
 return{had:deVig(official.hadOdds,3),hhad:Number.isInteger(official.handicap)?deVig(official.hhadOdds,3):null,
  total:deVig(official.totalOdds,8),score:deVig(official.scoreOdds,31),halfFull:deVig(official.halfFullOdds,9),handicap:official.handicap,
  fetchedAt:official.fetchedAt,source:"frozen-official-odds",decisionAt:input.decisionAt};
}
export function projectOfficialScores(points){
 const vector=completeDistribution(points,EXACT_SCORE_LABELS);if(!vector)return null;
 const labels=MARKET_META.score.labels,values=Array(labels.length).fill(0);
 EXACT_SCORE_LABELS.forEach((score,i)=>{const[h,a]=score.split(":").map(Number);const label=labels.includes(score)?score:h>a?"胜其他":h===a?"平其他":"负其他";values[labels.indexOf(label)]+=vector[i];});
 return values;
}
// Paired date-block resampling, not independent resampling of correlated games.
// A sparse interval is deliberately unavailable. It must not tune runtime weights.
export function pairedInterval(observations,key="brier",resamples=400){
 const rows=observations.filter(r=>Number.isFinite(r.model?.[key])&&Number.isFinite(r.market?.[key])),blocks=new Map();
 rows.forEach(row=>{const day=row.salesDate;blocks.set(day,[...(blocks.get(day)||[]),row.model[key]-row.market[key]]);});
 const mean=values=>values.reduce((a,b)=>a+b,0)/values.length,all=[...blocks.values()].flat(),delta=all.length?mean(all):null;
 const base={delta,lower:null,upper:null,sampleSize:rows.length,clusters:blocks.size,resamples:0,method:"paired-sales-date-block-bootstrap",negativeIsBetter:true,underpowered:rows.length<20||blocks.size<5};
 if(base.underpowered)return base;
 let seed=2166136261;for(const row of rows)for(const ch of `${row.key}|${key}`)seed=Math.imul(seed^ch.charCodeAt(0),16777619);
 const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};
 const values=[...blocks.values()],samples=[];
 for(let i=0;i<resamples;i++){let sum=0,count=0;for(let j=0;j<values.length;j++)for(const value of values[Math.floor(random()*values.length)]){sum+=value;count++;}samples.push(sum/count);}
 samples.sort((a,b)=>a-b);
 return{...base,lower:samples[Math.floor(resamples*.025)],upper:samples[Math.min(resamples-1,Math.floor(resamples*.975))],resamples};
}
