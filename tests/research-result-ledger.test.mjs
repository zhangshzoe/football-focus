import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

// When integrated as tests/research-result-ledger.test.mjs, no override is needed.
// A Temp-only run can set FOOTBALL_FOCUS_ROOT to the unchanged checkout.
const root=resolve(process.env.FOOTBALL_FOCUS_ROOT || fileURLToPath(new URL("../",import.meta.url)));
const {buildFirstObservedResult,freezeForwardManifest,mergeFirstObservedResults,verifyFirstObservedResult}=await import(pathToFileURL(join(root,"app","forward-validation.js")));
const {observeResearchResults}=await import(pathToFileURL(join(root,"app","research-result-observation.js")));
const {researchValidationView}=await import(pathToFileURL(join(root,"app","research-validation-view.js")));
const now=Date.parse("2026-09-26T12:00:00Z");
const sourcePage="https://cp.zgzcw.com/dc/getKaijiangFootBall.action";
const fixture={officialMatchId:"100001",salesDate:"2026-09-25",kickoffAt:"2026-09-25T18:00:00Z",home:"Home FC",away:"Away FC",league:"Ledger test league"};

function observation(firstObservedAt="2026-09-25T21:00:00Z",fullScore="2:1",identity=fixture){
 const [homeGoals,awayGoals]=fullScore.split(":").map(Number);
 const result={officialMatchId:identity.officialMatchId,salesDate:identity.salesDate,home:identity.home,away:identity.away,status:"settled",fullScore,hadResult:homeGoals>awayGoals?"胜":homeGoals===awayGoals?"平":"负",totalGoalsResult:homeGoals+awayGoals>=7?"7+":String(homeGoals+awayGoals)};
 const built=buildFirstObservedResult(result,[identity],firstObservedAt,sourcePage);
 assert.equal(built.status,"verified");
 return built.record;
}

test("same result event preserves the earliest instant regardless of input order or ISO timezone spelling",()=>{
 const earliest=observation("2026-09-26T05:20:00+08:00"),later=observation("2026-09-25T21:30:00Z");
 assert.equal(earliest.eventId,later.eventId);
 assert.ok(Date.parse(earliest.firstObservedAt)<Date.parse(later.firstObservedAt));
 for(const records of [[earliest,later],[later,earliest],[later,earliest,later]]){
  const merged=mergeFirstObservedResults(records,{now});
  assert.equal(merged.records.length,1);
  assert.deepEqual(merged.records[0],earliest);
  assert.deepEqual(merged.invalid,[]);
 }
});

test("different published outcomes for the same fixture remain separate conflict evidence",()=>{
 const win=observation(),loss=observation("2026-09-25T21:10:00Z","1:2");
 assert.equal(win.fixtureKey,loss.fixtureKey);
 assert.notEqual(win.outcomeHash,loss.outcomeHash);
 assert.notEqual(win.eventId,loss.eventId);
 const merged=mergeFirstObservedResults([win,loss,win,loss],{now});
 assert.equal(merged.records.length,2);
 assert.deepEqual(new Set(merged.records.map(record=>record.outcomeHash)),new Set([win.outcomeHash,loss.outcomeHash]));
 assert.deepEqual(merged.invalid,[]);
});

test("ordering uses observed instants across separate fixtures",()=>{
 const earliest=observation("2026-09-26T05:20:00+08:00"),later=observation("2026-09-25T21:30:00Z","2:1",{...fixture,officialMatchId:"100002"});
 assert.deepEqual(mergeFirstObservedResults([later,earliest],{now}).records.map(record=>record.eventId),[earliest.eventId,later.eventId]);
});

test("hash verification rejects changes to observed time, source, identity, outcome and raw evidence",()=>{
 const original=observation();
 assert.equal(verifyFirstObservedResult(JSON.parse(JSON.stringify(original)),{now}),true);
 const corruptions=[
  record=>{record.firstObservedAt="2026-09-25T21:01:00Z";},
  record=>{record.endedBeforeAt="2026-09-25T21:01:00Z";},
  record=>{record.fixtureKey="2026-09-25|999999";},
  record=>{record.fixture.home="Changed FC";},
  record=>{record.sourcePage="https://example.com/result";},
  record=>{record.sourceResult.fullScore="0:0";},
  record=>{record.sourceResult.hadResult="平";},
  record=>{record.fullScore="3:1";},
  record=>{record.responseHash="0".repeat(64);},
  record=>{record.outcomeHash="0".repeat(64);},
  record=>{record.contentHash="0".repeat(64);},
  record=>{record.eventId="result-"+"0".repeat(64);},
  record=>{record.immutable=false;}
 ];
 for(const corrupt of corruptions){
  const modified=structuredClone(original);corrupt(modified);
  assert.equal(verifyFirstObservedResult(modified,{now}),false);
  const merged=mergeFirstObservedResults([original,modified],{now});
  assert.deepEqual(merged.records,[original]);
  assert.equal(merged.invalid.length,1);
 }
});

test("trusted evaluation clock rejects hash-valid future observations and accepts its exact boundary",()=>{
 const atBoundary=observation("2026-09-26T12:00:00Z"),future=observation("2026-09-26T12:00:01Z");
 assert.equal(verifyFirstObservedResult(atBoundary,{now}),true);
 assert.equal(verifyFirstObservedResult(future,{now}),false);
 const merged=mergeFirstObservedResults([future,atBoundary],{now});
 assert.deepEqual(merged.records,[atBoundary]);
 assert.equal(merged.invalid.length,1);
});

// These harnesses run the real route/index source with only persistence, index
// input and framework response dependencies replaced. No fetch, DB operation,
// project write or persistent synthetic result is possible through the mocks.
let moduleNumber=0;
const memoryModule=source=>`data:text/javascript;base64,${Buffer.from(source+`\n// isolated-ledger-test-${moduleNumber++}`).toString("base64")}`;
function replaceImports(source,originalPath,replacements){
 return source.replace(/(\bfrom\s*|\bimport\s*)(["'])([^"']+)\2/g,(matched,prefix,quote,specifier)=>{
  const replacement=replacements[specifier] || (specifier.startsWith(".")?pathToFileURL(resolve(dirname(originalPath),specifier)).href:null);
  return replacement?`${prefix}${quote}${replacement}${quote}`:matched;
 });
}

async function resultApi(indexRecords,liveRecords){
 const routePath=join(root,"app","api","research-validation","route.ts");
 const typescript=createRequire(join(root,"package.json"))("typescript");
 const compiled=typescript.transpileModule(await readFile(routePath,"utf8"),{compilerOptions:{module:typescript.ModuleKind.ESNext,target:typescript.ScriptTarget.ES2022}}).outputText;
 const responseMock=memoryModule("export const NextResponse={json(body,options={}){return {status:options.status||200,headers:options.headers,json:async()=>body};}};");
 const indexMock=memoryModule(`export default ${JSON.stringify({schemaVersion:1,resultEvents:indexRecords})};`);
 const storeMock=memoryModule(`export async function readResearchResults(){return ${JSON.stringify(liveRecords)};}`);
 const cloudMock=memoryModule("export const getCloudResearchStore=()=>{throw new Error('Unexpected hosted storage in isolated test');};");
 const source=replaceImports(compiled,routePath,{"next/server":responseMock,"../../../data/generated-forward-validation-index.json":indexMock,"../../research-result-store":storeMock,"../../cloud-research-binding":cloudMock,"../../research-validation-view.js":pathToFileURL(join(root,"app","research-validation-view.js")).href});
 const api=await import(memoryModule(source));
 return api.GET(new Request("https://ledger-test.invalid/api/research-validation?view=events"));
}

async function syncIndex(localRecords,suppliedRecords){
 const scriptPath=join(root,"scripts","sync-forward-validation-index.mjs");
 const filesMock=memoryModule("export const state={writes:[],indexText:'null'};export async function readFile(){return state.indexText;}export async function writeFile(path,text){state.writes.push({path,text});state.indexText=text;}");
 const researchMock=memoryModule(`export async function readResearchFiles(path){return path.endsWith('research-result-events')?${JSON.stringify(localRecords)}:[];}export async function forwardCodeHashes(){return {};}`);
 const source=replaceImports(await readFile(scriptPath,"utf8"),scriptPath,{"node:fs/promises":filesMock,"./forward-research-files.mjs":researchMock});
 const script=await import(memoryModule(source));
 const summary=await script.syncForwardValidationIndex({resultEvents:suppliedRecords});
 const {state}=await import(filesMock);
 assert.equal(summary.status,"indexed");
 assert.equal(state.writes.length,1);
 return JSON.parse(state.writes[0].text);
}

test("research API merge cannot overwrite an earlier indexed observation with a later live record",async()=>{
 const earliest=observation("2026-09-26T05:20:00+08:00"),later=observation("2026-09-25T21:30:00Z"),conflict=observation("2026-09-25T21:40:00Z","1:2");
 for(const [indexed,live] of [[[earliest],[later,conflict]],[[later],[earliest,conflict]]]){
  const response=await resultApi(indexed,live);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.resultEvents.length,2);
  assert.deepEqual(body.resultEvents.find(record=>record.eventId===earliest.eventId),earliest);
  assert.ok(body.resultEvents.some(record=>record.eventId===conflict.eventId));
 }
});

test("index sync cannot overwrite an earlier local observation with a later API record",async()=>{
 const earliest=observation("2026-09-26T05:20:00+08:00"),later=observation("2026-09-25T21:30:00Z"),conflict=observation("2026-09-25T21:40:00Z","1:2");
 for(const [local,supplied] of [[[earliest],[later,conflict]],[[later],[earliest,conflict]]]){
  const index=await syncIndex(local,supplied);
  assert.equal(index.resultEvents.length,2);
  assert.deepEqual(index.resultEvents.find(record=>record.eventId===earliest.eventId),earliest);
  assert.ok(index.resultEvents.some(record=>record.eventId===conflict.eventId));
 }
});

test("API and index merge reject tampered and future records before exposing the ledger",async()=>{
 const original=observation(),tampered=structuredClone(original),future=observation("2099-09-25T21:00:00Z");
 tampered.firstObservedAt="2026-09-25T20:59:00Z";
 const response=await resultApi([original],[tampered,future]);
 assert.equal(response.status,200);
 assert.deepEqual((await response.json()).resultEvents,[original]);
 assert.deepEqual((await syncIndex([original],[tampered,future])).resultEvents,[original]);
});

function frozenCohort(overrides={}){
 return freezeForwardManifest({startAt:"2026-09-25T13:00:00Z",endAt:"2026-09-25T13:30:00Z",teamWeight:0.2,codeHashes:{model:"1".repeat(64),history:"2".repeat(64),team:"3".repeat(64),market:"4".repeat(64),policy:"5".repeat(64)},...overrides},"2026-09-24T12:00:00Z");
}

test("research observations require a valid pre-frozen manifest before ordinary results become evidence",()=>{
 const result=observation().sourceResult;
 for(const manifest of [null,undefined,{...frozenCohort(),manifestHash:"0".repeat(64)}]){
  assert.deepEqual(observeResearchResults({results:[result],fixtureUniverse:[fixture],manifest,observedAt:"2026-09-25T21:00:00Z",sourcePage}),{status:"not-frozen",records:[],rejected:[]});
 }
});

test("cohort membership follows fixed decision targets with inclusive start and exclusive end",()=>{
 const startFixture={...fixture,officialMatchId:"100010",kickoffAt:"2026-09-25T13:30:00Z"};
 const beforeEndFixture={...fixture,officialMatchId:"100011",kickoffAt:"2026-09-25T13:59:59Z"};
 const endFixture={...fixture,officialMatchId:"100012",kickoffAt:"2026-09-25T14:00:00Z"};
 const historicalFixture={...fixture,officialMatchId:"100013",salesDate:"2026-09-24",kickoffAt:"2026-09-24T13:30:00Z"};
 const unmappedFixture={...fixture,officialMatchId:"100014",kickoffAt:"2026-09-25T13:30:00Z"};
 const results=[startFixture,beforeEndFixture,endFixture,historicalFixture,unmappedFixture].map(row=>observation("2026-09-25T21:00:00Z","2:1",row).sourceResult);
 const observed=observeResearchResults({results,fixtureUniverse:[startFixture,beforeEndFixture,endFixture,historicalFixture],manifest:frozenCohort(),observedAt:"2026-09-25T21:00:00Z",sourcePage});
 assert.equal(observed.status,"observed");
 assert.deepEqual(observed.records.map(record=>record.fixture.officialMatchId),["100010","100011"]);
 assert.deepEqual(observed.rejected,[]);
 assert.ok(observed.records.every(record=>verifyFirstObservedResult(record,{now})));
});

test("a matching cohort key still needs unambiguous fixture identity and published terminal result cells",()=>{
 const cohortFixture={...fixture,kickoffAt:"2026-09-25T13:30:00Z"};
 const result=observation("2026-09-25T21:00:00Z","2:1",cohortFixture).sourceResult;
 const base={results:[result],fixtureUniverse:[cohortFixture],manifest:frozenCohort(),observedAt:"2026-09-25T21:00:00Z",sourcePage};
 const cases=[
  [{results:[{...result,home:"Unrelated FC"}]} ,"fixture-identity-unverified"],
  [{fixtureUniverse:[cohortFixture,{...cohortFixture,home:"Conflicting FC"}]} ,"fixture-identity-unverified"],
  [{results:[{...result,status:"live"}]} ,"terminal-result-unverified"],
  [{results:[{...result,hadResult:"平"}]} ,"published-result-cells-inconsistent"],
  [{observedAt:cohortFixture.kickoffAt} ,"terminal-result-unverified"],
  [{sourcePage:"https://example.com/results"} ,"missing-source-time"]
 ];
 for(const [overrides,reason] of cases){
  const observed=observeResearchResults({...base,...overrides});
  assert.deepEqual(observed.records,[]);
  assert.deepEqual(observed.rejected,[{key:`${cohortFixture.salesDate}|${cohortFixture.officialMatchId}`,reason}]);
 }
});

test("new or conflicting ledger evidence suspends cached eligibility until offline replay",()=>{
 const earliest=observation(),later=observation("2026-09-25T21:10:00Z"),conflict=observation("2026-09-25T21:20:00Z","1:2");
 const index={manifest:frozenCohort(),resultEvents:[later],evaluation:{status:"evaluated",eligible:true,sampleSize:100}};
 const advanced=researchValidationView(index,[earliest],now);
 assert.equal(advanced.unsyncedResultEvents,1);
 assert.equal(advanced.evaluation.status,"results-awaiting-replay");
 assert.equal(advanced.evaluation.eligible,false);
 assert.deepEqual(advanced.resultEvents,[earliest]);
 const stable=researchValidationView({...index,resultEvents:[earliest]},[later],now);
 assert.equal(stable.unsyncedResultEvents,0);
 assert.equal(stable.evaluation.eligible,true);
 const disputed=researchValidationView({...index,resultEvents:[earliest]},[conflict],now);
 assert.equal(disputed.resultEventCount,2);
 assert.equal(disputed.evaluation.eligible,false);
 const tampered=structuredClone(earliest);tampered.firstObservedAt="2026-09-25T20:00:00Z";
 const invalid=researchValidationView(index,[tampered],now);
 assert.equal(invalid.evaluation.status,"result-integrity-failed");
 assert.equal(invalid.evaluation.eligible,false);
});

async function withNodeEnvironment(value,task){
 const previous=process.env.NODE_ENV;
 process.env.NODE_ENV=value;
 try{return await task();}finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
}

async function resultStore(earlier,later){
 const storePath=join(root,"app","research-result-store.ts");
 const typescript=createRequire(join(root,"package.json"))("typescript");
 const compiled=typescript.transpileModule(await readFile(storePath,"utf8"),{compilerOptions:{module:typescript.ModuleKind.ESNext,target:typescript.ScriptTarget.ES2022}}).outputText;
 const fsMock=memoryModule(`
 import {basename} from 'node:path';
 export const state={files:new Map(),writes:[],emptyLists:0};
 let openLists,releaseLater;
 const bothLists=new Promise(resolve=>{openLists=resolve;});
 const laterWritten=new Promise(resolve=>{releaseLater=resolve;});
 export async function mkdir(){}
 export async function readdir(){
  const names=[...state.files.keys()].map(path=>basename(path));
  if(!names.length&&state.emptyLists<2){state.emptyLists++;if(state.emptyLists===2)openLists();await bothLists;}
  return names;
 }
 export async function readFile(path){if(!state.files.has(path))throw Object.assign(new Error('missing mock file'),{code:'ENOENT'});return state.files.get(path);}
 export async function writeFile(path,text,options){
  const record=JSON.parse(text);
  if(record.contentHash===${JSON.stringify(earlier.contentHash)})await laterWritten;
  if(state.files.has(path)&&options?.flag==='wx')throw Object.assign(new Error('mock existing observation'),{code:'EEXIST'});
  state.files.set(path,text);state.writes.push({path,record});
  if(record.contentHash===${JSON.stringify(later.contentHash)})releaseLater();
 }
 `);
 const dbMock=memoryModule(`
 export const state={rows:new Map(),writes:[],emptyQueries:0};
 let openQueries,releaseLater;
 const bothQueries=new Promise(resolve=>{openQueries=resolve;});
 const laterWritten=new Promise(resolve=>{releaseLater=resolve;});
 export const env={DB:{prepare(sql){return {bind(...values){return {
  async all(){
   if(sql.includes('FROM research_capture_leases'))return {results:[{fence:1}]};
   if(sql.includes('WHERE fixture_key')){
    const rows=[...state.rows.values()].filter(row=>row.fixture_key===values[0]&&row.outcome_hash===values[1]);
    if(!rows.length&&state.emptyQueries<2){state.emptyQueries++;if(state.emptyQueries===2)openQueries();await bothQueries;}
    return {results:rows};
   }
   if(sql.includes('WHERE id'))return {results:state.rows.has(values[0])?[state.rows.get(values[0])]:[]};
   if(sql.includes('ORDER BY'))return {results:[...state.rows.values()]};
   throw new Error('unexpected mock select '+sql);
  },
  async run(){
   if(!sql.startsWith('INSERT INTO research_result_events'))throw new Error('unexpected mock write '+sql);
   const record=JSON.parse(values[4]);
   if(record.contentHash===${JSON.stringify(earlier.contentHash)})await laterWritten;
   if(!state.rows.has(values[0])){state.rows.set(values[0],{fixture_key:values[1],outcome_hash:values[3],payload_json:values[4]});state.writes.push({id:values[0],record});}
   if(record.contentHash===${JSON.stringify(later.contentHash)})releaseLater();
  }
 };}};}}};
 `);
 const source=replaceImports(compiled,storePath,{"cloudflare:workers":dbMock,"node:fs/promises":fsMock});
 const store=await import(memoryModule(source));
 const {state:fsState}=await import(fsMock),{state:dbState}=await import(dbMock);
 return {store,fsState,dbState};
}

test("concurrent local writes retain the earlier observation even when the later request persists first",async()=>{
 const earlier=observation("2026-09-26T05:20:00+08:00"),later=observation("2026-09-25T21:30:00Z");
 await withNodeEnvironment("test",async()=>{
  const {store,fsState,dbState}=await resultStore(earlier,later);
  await Promise.all([store.appendResearchResult(earlier),store.appendResearchResult(later)]);
  assert.deepEqual(fsState.writes.map(write=>write.record.contentHash),[later.contentHash,earlier.contentHash]);
  assert.equal(fsState.files.size,2);
  assert.equal(dbState.writes.length,0);
  for(const write of fsState.writes)assert.ok(write.path.endsWith(`${write.record.eventId}.${write.record.contentHash}.json`));
  const stored=await store.readResearchResults();
  assert.equal(stored.length,2);
  assert.deepEqual(mergeFirstObservedResults(stored,{now}).records,[earlier]);
  assert.deepEqual(await store.appendResearchResult(later),earlier);
  assert.equal(fsState.writes.length,2);
 });
});

test("concurrent D1 writes use immutable observation IDs and retain earlier evidence without updating a row",async()=>{
 const earlier=observation("2026-09-26T05:20:00+08:00"),later=observation("2026-09-25T21:30:00Z");
 await withNodeEnvironment("production",async()=>{
  const {store,fsState,dbState}=await resultStore(earlier,later);
  const lease={scope:"research-writer",token:"test-writer-token",fence:1};
  await assert.rejects(store.appendResearchResult(earlier),/资格已失效/);
  await Promise.all([store.appendResearchResult(earlier,lease),store.appendResearchResult(later,lease)]);
  assert.deepEqual(dbState.writes.map(write=>write.record.contentHash),[later.contentHash,earlier.contentHash]);
  assert.equal(dbState.rows.size,2);
  assert.equal(fsState.writes.length,0);
  for(const write of dbState.writes)assert.equal(write.id,`${write.record.eventId}-${write.record.contentHash}`);
  const stored=await store.readResearchResults();
  assert.equal(stored.length,2);
  assert.deepEqual(mergeFirstObservedResults(stored,{now}).records,[earlier]);
  assert.deepEqual(await store.appendResearchResult(later,lease),earlier);
  assert.equal(dbState.writes.length,2);
 });
});
