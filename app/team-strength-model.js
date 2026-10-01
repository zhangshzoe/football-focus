// Research candidate only: no market prices, no future results, no automatic promotion.
export function fitTeamStrength(fixtures, {league,homeTeamId,awayTeamId,decisionAt}={}) {
 const cutoff=Date.parse(decisionAt||""), byId=new Map();
 for(const row of fixtures||[]){
  const at=Date.parse(row.completedBefore||""),h=Number(row.homeGoals),a=Number(row.awayGoals);
  if(row.league!==league||!Number.isFinite(at)||at>=cutoff||!Number.isFinite(Date.parse(row.observedAt))||Date.parse(row.observedAt)>cutoff||!row.homeTeamId||!row.awayTeamId||!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0)continue;
  const key=row.fixtureId||`${row.date}|${row.homeTeamId}|${row.awayTeamId}`;
  if(!byId.has(key))byId.set(key,{...row,h,a,weight:Math.exp(-Math.LN2*(cutoff-at)/(120*86400000))});
 }
 const rows=[...byId.values()],ids=[...new Set(rows.flatMap(r=>[r.homeTeamId,r.awayTeamId]))],index=new Map(ids.map((id,i)=>[id,i]));
 const counts=new Map(ids.map(id=>[id,rows.filter(r=>r.homeTeamId===id||r.awayTeamId===id).length]));
 const meta={status:"insufficient-data",shadowOnly:true,method:"time-decayed-ridge-poisson-opponent-adjusted-v1",sampleSize:rows.length,teamSampleSizes:{home:counts.get(homeTeamId)||0,away:counts.get(awayTeamId)||0},halfLifeDays:120,usesXg:false,usesMarketOdds:false,promotion:"requires-frozen-forward-validation"};
 if(!Number.isFinite(cutoff)||rows.length<40||(counts.get(homeTeamId)||0)<6||(counts.get(awayTeamId)||0)<6)return meta;
 let intercept=Math.log(Math.max(.2,rows.reduce((s,r)=>s+r.h+r.a,0)/(2*rows.length))),advantage=.12;
 const attack=ids.map(()=>0),defense=ids.map(()=>0),clip=x=>Math.max(-1.2,Math.min(1.2,x));
 for(let iteration=0;iteration<350;iteration++){
  const ga=ids.map(()=>0),gd=ids.map(()=>0),den=ids.map(()=>4);let gi=0,gh=0,totalWeight=0;
  for(const r of rows){const hi=index.get(r.homeTeamId),ai=index.get(r.awayTeamId),lh=Math.exp(intercept+advantage+attack[hi]-defense[ai]),la=Math.exp(intercept+attack[ai]-defense[hi]),eh=(lh-r.h)*r.weight,ea=(la-r.a)*r.weight;
   ga[hi]+=eh;ga[ai]+=ea;gd[ai]-=eh;gd[hi]-=ea;den[hi]+=r.weight;den[ai]+=r.weight;gi+=eh+ea;gh+=eh;totalWeight+=r.weight;
  }
  intercept-=.06*gi/(2*totalWeight);advantage=clip(advantage-.06*(gh+2*advantage)/(totalWeight+2));
  for(let i=0;i<ids.length;i++){attack[i]=clip(attack[i]-.06*(ga[i]+4*attack[i])/den[i]);defense[i]=clip(defense[i]-.06*(gd[i]+4*defense[i])/den[i]);}
  const ma=attack.reduce((s,v)=>s+v,0)/ids.length,md=defense.reduce((s,v)=>s+v,0)/ids.length;
  for(let i=0;i<ids.length;i++){attack[i]-=ma;defense[i]-=md;}intercept+=ma-md;
 }
 const hi=index.get(homeTeamId),ai=index.get(awayTeamId),home=Math.exp(intercept+advantage+attack[hi]-defense[ai]),away=Math.exp(intercept+attack[ai]-defense[hi]);
 const pmf=lambda=>{const out=[Math.exp(-lambda)];for(let i=1;i<=12;i++)out.push(out[i-1]*lambda/i);return out;},hp=pmf(home),ap=pmf(away),points=[];
 for(let h=0;h<=12;h++)for(let a=0;a<=12;a++)points.push({score:`${h}:${a}`,probability:hp[h]*ap[a]*100});
 const mass=points.reduce((s,p)=>s+p.probability,0);points.forEach(p=>p.probability=p.probability*100/mass);
 return{...meta,status:"ready",expectedGoals:{home,away},homeAdvantageLog:advantage,fullScoreDistribution:points,retainedMass:mass/100,teamRatings:{home:{attack:attack[hi],defense:defense[hi]},away:{attack:attack[ai],defense:defense[ai]}}};
}
