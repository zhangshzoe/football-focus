import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {MARKET_META} from '../app/purchase-plan-engine.js';
const source=(await readFile(new URL('../app/recommendation-returns.ts',import.meta.url),'utf8'))
  .replace('"./purchase-plan-engine"',JSON.stringify(new URL('../app/purchase-plan-engine.js',import.meta.url).href));
const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {priceRecommendationSelections:price,calculateRecommendationReturns:calculate}=await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
const leg=(key,odds,market='had')=>({matchKey:key,market,scores:odds.map((odd,i)=>({score:MARKET_META[market].labels[i],probability:20,odd}))});

test('all five markets quote exact current official labels, never model probabilities',()=>{
  for(const [market,meta] of Object.entries(MARKET_META)){
    const odds=meta.labels.map((_,i)=>1.1+i/10);
    const points=meta.labels.map(score=>({score,probability:99}));
    assert.deepEqual(price(points,market,{marketOdds:{[meta.name]:odds}}).map(p=>p.odd),odds);
  }
  assert.equal(price([{score:'7球',probability:20}],'total',{marketOdds:{'总进球数':[1,2,3,4,5,6,7,8]}})[0].odd,8);
  assert.equal(price([{score:'1：0',probability:20}],'score',{marketOdds:{'比分':[7.2]}})[0].odd,7.2);
});
test('two choices in each of two matches cost eight yuan and subtract the whole group cost',()=>{
  const result=calculate([leg('a',[2,3]),leg('b',[6,10])]);
  assert.equal(result.betCount,4);assert.equal(result.totalStake,8);
  assert.equal(result.minWinningReturn,24);assert.equal(result.maxWinningReturn,60);
  assert.equal(result.minWinningProfit,16);assert.equal(result.maxWinningProfit,52);
  assert.equal(result.worstCaseProfit,-8);
});
test('expected payout sums the four purchased bets, not the two standalone fixtures',()=>{
  const a=leg('a',[2,3]), b=leg('b',[4,8]);
  a.scores[0].probability=30; a.scores[1].probability=20;
  b.scores[0].probability=40; b.scores[1].probability=10;
  const result=calculate([a,b]);
  // 0.3*0.4*16 + 0.3*0.1*32 + 0.2*0.4*24 + 0.2*0.1*48
  assert.ok(Math.abs(result.expectedReturn-5.76)<1e-10);
  assert.equal(result.betCount,4); assert.equal(result.totalStake,8);
  assert.notEqual(result.expectedReturn,calculate([a]).expectedReturn+calculate([b]).expectedReturn);
});
test('expected payout retains per-bet rounding, caps, misses and missing probabilities',()=>{
  const a=leg('a',[1.65]),b=leg('b',[1.75]);
  assert.ok(Math.abs(calculate([a,b]).expectedReturn-0.04*5.78)<1e-10);
  assert.ok(Math.abs(calculate([leg('a',[100000]),leg('b',[100000])]).expectedReturn-8000)<1e-8);
  a.scores[0].probability=0; assert.equal(calculate([a,b]).expectedReturn,0);
  for(const value of [undefined,null,NaN,-1,101]){
    a.scores[0].probability=value; assert.equal(calculate([a,b]).expectedReturn,null);
  }
});
test('single-selection, mixed-market and winning-but-negative groups retain correct costs',()=>{
  const one=calculate([leg('a',[2.5])]);
  assert.equal(one.totalStake,2);assert.equal(one.minWinningProfit,3);assert.equal(one.maxWinningProfit,3);
  const mixed=calculate([leg('a',[2,3],'score'),leg('b',[4],'halfFull'),leg('c',[5,6],'total')]);
  assert.equal(mixed.betCount,4);assert.equal(mixed.minWinningProfit,72);assert.equal(mixed.maxWinningProfit,136);
  assert.equal(calculate([leg('a',[1.1,1.2]),leg('b',[1.1,1.2])]).minWinningProfit,-5.58);
});
test('missing, invalid and unmapped official quotes do not produce an invented return range',()=>{
  for(const raw of [undefined,null,0,'--',Infinity,-1]){
    const scores=price([{score:'胜',probability:99}],'had',{marketOdds:{'胜平负':[raw]}});
    const result=calculate([{matchKey:'a',market:'had',scores}]);
    assert.equal(result.status,'unavailable');assert.equal(result.totalStake,2);
    assert.equal(result.maxWinningReturn,undefined);
  }
  assert.equal(price([{score:'6:0',probability:15}],'score',{marketOdds:{'比分':Array(31).fill(10)}})[0].odd,null);
  assert.equal(price([{score:'胜',probability:20}],'had',{odds:[99],marketStatus:{'胜平负':'failed'},marketOdds:{'胜平负':[2]}})[0].odd,null);
});
test('official cent rounding and per-bet bonus caps use precise decimal products',()=>{
  assert.equal(calculate([leg('a',[1.65]),leg('b',[1.75])]).maxWinningReturn,5.78);
  assert.equal(calculate([leg('a',[1.61]),leg('b',[1.25])]).maxWinningReturn,4.02);
  assert.equal(calculate([leg('a',[1.63]),leg('b',[1.25])]).maxWinningReturn,4.08);
  assert.equal(calculate([leg('a',[1.65]),leg('b',[1.75]),leg('c',[1.46])]).maxWinningReturn,8.43);
  for(const [count,cap]of [[1,100000],[2,200000],[3,200000],[4,500000],[5,500000],[6,1000000],[8,1000000]]){
    const result=calculate(Array.from({length:count},(_,i)=>leg(String(i),[100000])));
    assert.equal(result.maxWinningReturn,cap);assert.equal(result.maxWinningProfit,cap-2);assert.equal(result.capped,true);
  }
});
test('quotes freeze independently; duplicate fixtures, duplicate selections and invalid passes are rejected',()=>{
  const official={marketOdds:{'胜平负':[2,3,4]}};
  const priced=price([{score:'胜',probability:20}],'had',official);
  official.marketOdds['胜平负'][0]=20;assert.equal(priced[0].odd,2);
  assert.throws(()=>calculate([leg('a',[2]),leg('a',[3])]));
  assert.throws(()=>calculate([{...leg('a',[2,3]),scores:[priced[0],priced[0]]}]));
  assert.throws(()=>calculate(Array.from({length:5},(_,i)=>leg(String(i),[2],'score'))));
  assert.throws(()=>calculate([]));
});
