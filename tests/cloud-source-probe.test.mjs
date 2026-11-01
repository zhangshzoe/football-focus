import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';
import {probeOfficialSource} from '../app/cloud-handoff/source-probe.js';
import {handoffMcp} from '../app/cloud-handoff/mcp.js';
const pools=['HAD','HHAD','CRS','TTG','HAFU'];
test('primary denial never triggers repair or mobile fallback for probe',async()=>{
 const source=readFileSync(new URL('../app/sporttery-official.ts',import.meta.url),'utf8');
 const compiled=transpileModule(source,{compilerOptions:{module:ModuleKind.CommonJS,target:ScriptTarget.ES2022}}).outputText;
 const calls=[],scope={exports:{},fetch:async(url,options)=>{calls.push({url,options});return new Response('denied',{status:403})}};
 new Function(...Object.keys(scope),compiled)(...Object.values(scope));
 const result=await probeOfficialSource(()=>scope.exports.fetchOfficialSporttery({repair:false,serverHeaders:true,allowMobileFallback:false}));
 assert.equal(calls.length,5);assert.ok(calls.every(c=>new URL(c.url).searchParams.get('channel')==='0005'));
 assert.equal(result.code,'OFFICIAL_ACCESS_BLOCKED');assert.deepEqual(result.httpCodes,[403]);assert.equal(result.matchCount,null);assert.equal(result.fetchedAt,null);assert.equal(result.sourceReady,false);
 assert.ok(pools.every(p=>result.pools[p].status==='failed'&&result.pools[p].error.includes('403')));
});
test('fresh, partial, empty and stale source summaries retain facts without raw matches',async()=>{
 const data=()=>({fetchedAt:new Date().toISOString(),upstreamUpdatedAt:new Date().toISOString(),poolStatus:Object.fromEntries(pools.map(p=>[p,{status:'success',matchCount:1,upstreamUpdatedAt:new Date().toISOString()}])),matches:[{privateRaw:'not-returned'}]});
 const fresh=await probeOfficialSource(async()=>data());assert.equal(fresh.sourceReady,true);assert.equal(fresh.matchCount,1);assert.equal(Object.hasOwn(fresh,'matches'),false);
 const unknownPool=data();delete unknownPool.poolStatus.HAD.upstreamUpdatedAt;assert.equal((await probeOfficialSource(async()=>unknownPool)).sourceReady,false);
 const stalePool=data();stalePool.poolStatus.HAD.upstreamUpdatedAt='2000-01-01 00:00:00';assert.equal((await probeOfficialSource(async()=>stalePool)).sourceReady,false);
 const partial=data();partial.poolStatus.CRS={status:'failed',matchCount:0,error:'返回 567'};const p=await probeOfficialSource(async()=>partial);assert.equal(p.status,'partial');assert.equal(p.sourceReady,false);assert.deepEqual(p.pools.CRS.httpCodes,[567]);
 assert.equal((await probeOfficialSource(async()=>({...data(),matches:[]}))).status,'empty');
 assert.equal((await probeOfficialSource(async()=>({...data(),upstreamUpdatedAt:'2000-01-01 00:00:00'}))).sourceReady,false);
 assert.equal((await probeOfficialSource(async()=>({...data(),upstreamUpdatedAt:''}))).sourceReady,false);
});
test('source tool is owner-only, no caller URL and no persistence access',async()=>{
 let reads=0;const deniedDb=new Proxy({},{get(){throw new Error('PERSISTENCE_TOUCHED')}});
 const env={PREDICTION_OPERATOR_EMAIL:'owner@example.test',DB:deniedDb,RESEARCH_OBJECTS:deniedDb};
 const invoke=(email,args={})=>handoffMcp(new Request('https://example.test/mcp',{method:'POST',headers:{'oai-authenticated-user-id':'owner','oai-authenticated-user-email':email},body:JSON.stringify({id:1,method:'tools/call',params:{name:'football_source_probe',arguments:args}})}),env,{readOfficialSource:async()=>{reads++;throw new Error('original failure')}});
 assert.equal((await invoke('not-owner@example.test')).status,403);assert.equal(reads,0);
 const bad=await (await invoke('owner@example.test',{url:'https://not-permitted.test'})).json();assert.equal(bad.result.isError,true);assert.equal(reads,0);
 const response=await (await invoke('owner@example.test')).json();const result=JSON.parse(response.result.content[0].text);assert.equal(reads,1);assert.equal(result.error,'original failure');assert.equal(result.persisted,false);
});
