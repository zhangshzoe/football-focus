import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {authorizeOwner,HandoffStore,mergeVerifiedRecords,readProductionProjection,readProductionProjectionForDisplay} from '../app/cloud-handoff/store.js';
import {handoffMcp} from '../app/cloud-handoff/mcp.js';
function fixture(){
 const sql=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(n=>n.endsWith('.sql')).sort())sql.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 const db={prepare(query){return{async all(){return {results:sql.prepare(query).all()}},bind(...params){return{async first(){return sql.prepare(query).get(...params)||null},async run(){return sql.prepare(query).run(...params)},async all(){return {results:sql.prepare(query).all(...params)}}}}}}};
 const objects=new Map(),bucket={async put(key,raw){if(!objects.has(key))objects.set(key,raw)},async get(key){return objects.has(key)?{async text(){return objects.get(key)}}:null}};
 return {store:new HandoffStore(db,bucket),db,bucket,objects,sql};
}
const namespace='test-contract',key=namespace+'|2026-11-01|purchase|1700';
const evidence={namespace,key,kind:'snapshots',id:'source-1',raw:'{"actualCapturedAt":"2026-11-01T09:12:34Z"}',observedAt:'2026-11-01T09:12:34Z'};
test('atomic claims serialize duplicate and different task types',async()=>{
 const {store}=fixture();const claims=await Promise.all([store.claim({namespace,key}),store.claim({namespace,key}),store.claim({namespace,key:namespace+'|2026-11-01|daily|1730'})]);
 assert.equal(claims.filter(x=>x.claimed).length,1);assert.equal(claims[2].status,'writer-busy');
});
test('raw readback survives new store instance, idempotent bytes and hash conflicts',async()=>{
 const {store,db,bucket,objects}=fixture();const claim=await store.claim({namespace,key});
 const saved=await store.write({...evidence,token:claim.token});
 assert.equal((await store.write({...evidence,token:claim.token})).content_hash,saved.content_hash);
 assert.equal(objects.size,1);
 assert.equal((await new HandoffStore(db,bucket).get(namespace,evidence.kind,evidence.id)).raw,evidence.raw);
 await assert.rejects(store.write({...evidence,token:claim.token,raw:'changed'}),/IMMUTABLE_HASH_CONFLICT/);
 objects.set(saved.object_key,'corrupted');await assert.rejects(store.get(namespace,evidence.kind,evidence.id),/HASH_MISMATCH/);
});
test('failed is terminal and stale/wrong owners cannot publish or complete',async()=>{
 const {store}=fixture();const claim=await store.claim({namespace,key});
 await assert.rejects(store.write({...evidence,token:'wrong'}),/FENCE/);
 await store.finish({namespace,key,token:claim.token,status:'failed',failureCode:'SOURCE_BLOCKED'});
 assert.equal((await store.claim({namespace,key})).claimed,false);
 await assert.rejects(store.write({...evidence,token:claim.token}),/FENCE/);
 await assert.rejects(store.finish({namespace,key,token:claim.token,status:'complete'}),/FENCE/);
});
test('test writers cannot claim or write production and namespace reads isolate',async()=>{
 const {store}=fixture();await assert.rejects(store.claim({namespace:'production',key:'production|x'}),/DISABLED/);
 const claim=await store.claim({namespace,key});await store.write({...evidence,token:claim.token});
 assert.equal(await store.get('production',evidence.kind,evidence.id),null);
 await assert.rejects(store.write({...evidence,namespace:'test-other',token:claim.token}),/FENCE/);
});
test('conservative projection merge preserves all unknown and nested history',()=>{
 const base={snapshots:[{snapshotId:'old',capturedAt:''}],purchasePlanSnapshots:[],captureAttempts:[{id:'attempt'}],captureEvents:[],resultSync:{recoveryQueue:[{id:'pending'}],identityConflicts:[{id:'conflict'}],identityResolutions:[{id:'resolved'}],fixedTicketRecovery:{original:12}},unknown:{future:true}};
 const old=JSON.stringify(base),delta={kind:'snapshots',id:'new',payload:{snapshotId:'new',capturedAt:'2026-11-01T09:12:34Z'}};
 const merged=mergeVerifiedRecords(base,[delta]);assert.deepEqual(merged.resultSync,base.resultSync);assert.deepEqual(merged.unknown,base.unknown);assert.equal(merged.snapshots.length,2);assert.equal(JSON.stringify(base),old);
 assert.deepEqual(mergeVerifiedRecords(merged,[delta]),merged);
 assert.throws(()=>mergeVerifiedRecords(base,[{...delta,id:'old',payload:{snapshotId:'old',capturedAt:'invented'}}]),/CONFLICT/);
 assert.throws(()=>mergeVerifiedRecords(null,[]),/MISSING_BASELINE/);
});
test('owner authentication requires platform id and matching configured verified email',()=>{
 const h=new Headers({'oai-authenticated-user-id':'site-user','oai-authenticated-user-email':'owner@example.test'});
 assert.equal(authorizeOwner(h,'owner@example.test'),'site-user');
 assert.throws(()=>authorizeOwner(h,''),/IDENTITY/);assert.throws(()=>authorizeOwner(h,'someone@example.test'),/IDENTITY/);
 h.delete('oai-authenticated-user-id');assert.throws(()=>authorizeOwner(h,'owner@example.test'),/IDENTITY/);
});
test('MCP probe writes synthetic test bytes once and readback verifies, no production tools',async()=>{
 const {db,bucket,objects}=fixture();const env={DB:db,RESEARCH_OBJECTS:bucket,PREDICTION_OPERATOR_EMAIL:'owner@example.test'};
 const call=async(name,requestId='proof')=>{const r=await handoffMcp(new Request('https://example.test/mcp',{method:'POST',headers:{'oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.test'},body:JSON.stringify({id:1,method:'tools/call',params:{name,arguments:{requestId}}})}),env);return (await r.json()).result};
 const a=await call('football_test_persistence'),b=await call('football_test_persistence'),c=await call('football_test_readback');assert.deepEqual(a,b);assert.deepEqual(b,c);assert.equal(objects.size,1);assert.equal(JSON.parse(a.content[0].text).productionEnabled,false);
 assert.equal((await call('capture_production')).isError,true);
 const rejected=await handoffMcp(new Request('https://example.test/mcp',{method:'POST',body:'{}'}),env);assert.equal(rejected.status,403);
});

 test('production projection reader excludes test records and preserves full baseline',async()=>{
  const {store,db,bucket}=fixture(),baseline={snapshots:[{snapshotId:'old'}],resultSync:{identityResolutions:['keep']},captureEvents:[{id:'keep'}]};
  const claim=await store.claim({namespace,key});await store.write({...evidence,token:claim.token});
  assert.deepEqual(await readProductionProjection(db,bucket,baseline),{index:baseline,status:'d1-empty-baseline-preserved'});
 });
 test('actual migration rejects metadata mutation, batch deletion and identity change',async()=>{
  const {store,sql}=fixture();const claim=await store.claim({namespace,key});await store.write({...evidence,token:claim.token});
  assert.throws(()=>sql.prepare('DELETE FROM cloud_handoff_records').run(),/immutable/);
  assert.throws(()=>sql.prepare("UPDATE cloud_handoff_records SET content_hash = 'bad'").run(),/immutable/);
  assert.throws(()=>sql.prepare('DELETE FROM cloud_handoff_batches').run());
  assert.throws(()=>sql.prepare("UPDATE cloud_handoff_batches SET owner_token = 'bad'").run());
 });

 test('storage faults explicitly degrade display without deleting baseline history',async()=>{
  const {db,bucket,sql}=fixture(),baseline={snapshots:[{snapshotId:'retained'}]};
  sql.exec('DROP TABLE cloud_handoff_records');
  await assert.rejects(readProductionProjection(db,bucket,baseline));
  assert.deepEqual(await readProductionProjectionForDisplay(db,bucket,baseline),{index:baseline,status:'degraded-baseline-only',error:'PERSISTENT_HISTORY_UNVERIFIED'});
 });

 test('prototype-shaped cache IDs remain own data without prototype mutation',()=>{
  const merged=mergeVerifiedRecords({resultCache:{}},[{kind:'resultCache',id:'__proto__',payload:{verified:true}}]);
  assert.equal(Object.getPrototypeOf(merged.resultCache),Object.prototype);
  assert.equal(Object.hasOwn(merged.resultCache,'__proto__'),true);
  assert.equal(merged.resultCache.__proto__.verified,true);
 });
 test('malformed MCP JSON objects fail with controlled bad request',async()=>{
  for(const body of ['null','[]','123','{}']) {
   const response=await handoffMcp(new Request('https://example.test/mcp',{method:'POST',headers:{'oai-authenticated-user-id':'owner','oai-authenticated-user-email':'owner@example.test'},body}),{PREDICTION_OPERATOR_EMAIL:'owner@example.test'});
   assert.equal(response.status,400);
  }
 });
 test('activated MCP discovery exposes only four owner-only test/read tools',async()=>{
  const env={PREDICTION_OPERATOR_EMAIL:'owner@example.test'};
  const call=async(method,email='owner@example.test',args={})=>handoffMcp(new Request('https://example.test/mcp',{method:'POST',headers:{'oai-authenticated-user-id':'site-user','oai-authenticated-user-email':email},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:args})}),env);
  assert.equal((await call('tools/list','other@example.test')).status,403);
  const discovery=await (await call('server/discover')).json();assert.deepEqual(discovery.result.supportedVersions,['2026-07-28']);
  const list=await (await call('tools/list')).json();assert.deepEqual(list.result.tools.map(t=>t.name),['football_source_probe','football_handoff_status','football_test_persistence','football_test_readback']);
  for(const args of [{requestId:123},[],{requestId:'probe',namespace:'production'}]){
   const response=await (await call('tools/call','owner@example.test',{name:'football_test_persistence',arguments:args})).json();
   assert.equal(response.result.isError,true);assert.equal(response.result.content[0].text,'INVALID_TOOL_ARGUMENTS');
  }
 });
 test('manifest enables MCP without changing identity or durable bindings',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../.openai/hosting.json',import.meta.url),'utf8'));
  assert.equal(manifest.project_id,'appgprj_6aa79bbb71c48191ab60e31bc521f293');assert.equal(manifest.d1,'DB');assert.equal(manifest.r2,'RESEARCH_OBJECTS');assert.deepEqual(manifest.capabilities,['mcp']);
 });
