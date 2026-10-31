import test from 'node:test';
import assert from 'node:assert/strict';
import {loadValidationSources} from '../app/data-validation/load-validation.js';
const reply=(data,ok=true,status=200)=>({ok,status,json:async()=>data});
test('failed official source remains null; history survives; predictions not called',async()=>{
 const calls=[];
 const result=await loadValidationSources(async path=>{calls.push(path);return path==='/api/sporttery'?reply({error:'官方拒绝访问'},false,503):reply({audit:{generatedAt:'2026-09-12'}})});
 assert.equal(result.official,null);assert.equal(result.predictions,null);assert.match(result.errors.official,/拒绝/);assert.ok(result.audit);assert.equal(calls.length,2);
});
test('empty official response is not a source failure and does not generate predictions',async()=>{
 const result=await loadValidationSources(async path=>reply(path==='/api/sporttery'?{matches:[]}:{audit:{}}));
 assert.deepEqual(result.official.matches,[]);assert.equal(result.predictions,null);assert.deepEqual(result.errors,{});
});
test('formal POST forwards official provenance, uses no manual mappings and no fallback',async()=>{
 let body;
 const result=await loadValidationSources(async(path,options)=>{
  if(path==='/api/sporttery')return reply({fetchedAt:'2026-10-31T00:00:00Z',matches:[{matchId:'123',marketOdds:{'让球胜平负':[2,3,4]}}]});
  if(path==='/api/model-audit')return reply({audit:{}});
  assert.equal(options.method,'POST');body=JSON.parse(options.body);return reply({reports:[]});
 },{forceRefresh:true});
 assert.equal(body.matches[0].officialMatchId,'123');assert.equal(body.matches[0].sourceFetchedAt,'2026-10-31T00:00:00Z');assert.deepEqual(body.matches[0].hhadOdds,[2,3,4]);assert.equal(body.forceRefresh,true);assert.equal(body.manualMappings,undefined);assert.ok(result.predictions);
});
test('malformed source payload is reported not accepted',async()=>{
 const result=await loadValidationSources(async()=>reply({}));
 assert.equal(result.official,null);assert.equal(result.audit,null);assert.match(result.errors.official,/数组/);
});
test('timeout retains independently successful audit results',async()=>{
 const c=new AbortController();
 const result=await loadValidationSources(async path=>{if(path==='/api/model-audit')return reply({audit:{generatedAt:'old'}});await new Promise(resolve=>setTimeout(resolve,5));c.abort();throw new Error('timeout')},{signal:c.signal});
 assert.ok(result.audit);assert.equal(result.official,null);assert.match(result.errors.official,/timeout/);
});
