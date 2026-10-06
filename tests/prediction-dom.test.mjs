import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import ts from "typescript";
import {JSDOM} from "jsdom";
import {IDBFactory,IDBObjectStore} from "fake-indexeddb";
import {act,createElement as h} from "react";
import {renderToString} from "react-dom/server";
import {createRoot,hydrateRoot} from "react-dom/client";

const moduleUrls=new Map();
const dataUrl=source=>`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function componentUrl(file){
 if(moduleUrls.has(file.href))return moduleUrls.get(file.href);
 const pending=(async()=>{
  let source=await readFile(file,"utf8");
  if(file.pathname.endsWith(".json"))return dataUrl(`export default ${JSON.stringify(JSON.parse(source))};`);
  // CSS modules are compiled by Vite in browser/build tests; expose their class
  // names here so this JS-only harness can still exercise real component logic.
  source=source.replace(/^import (\w+) from ["']([^"']+\.module\.css)["'];?\s*$/gm,
    (_,name)=>`const ${name}=new Proxy({}, {get:(_target,key)=>String(key)});\n`);
  source=source.replace(/^import ["'][^"']+\.css["'];?\s*$/gm,"");
  let output=ts.transpileModule(source,{fileName:file.pathname,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const imports=[...output.matchAll(/\bfrom\s+(["'])([^"']+)\1/g)];
  for(const [,quote,specifier] of imports){
   let resolved;
   if(specifier.startsWith(".")){
    const base=new URL(specifier,file);
    let dependency;
    for(const suffix of /\.(?:[cm]?js|tsx?|json)$/.test(base.pathname)?[""]:[".tsx",".ts",".js"]){
     const candidate=new URL(base.href+suffix);
     try{await readFile(candidate);dependency=candidate;break}catch(error){if(error.code!=="ENOENT")throw error}
    }
    if(!dependency)throw new Error(`Unresolved test component import: ${specifier}`);
    resolved=await componentUrl(dependency);
   }else if(specifier==="next/font/google"){
    resolved=dataUrl('export const Geist=options=>({variable:options.variable});export const Geist_Mono=Geist;');
   }else if(specifier==="next/navigation"){
    resolved=dataUrl('export const usePathname=()=>"/predictions";');
   }else resolved=import.meta.resolve(specifier);
   output=output.replaceAll(`${quote}${specifier}${quote}`,JSON.stringify(resolved));
  }
  return dataUrl(output);
 })();
 moduleUrls.set(file.href,pending);
 return pending;
}
const load=async path=>(await import(await componentUrl(new URL(path,import.meta.url)))).default;

function installDom(html="<!doctype html><html><body><div id='test-root'></div></body></html>"){
 const dom=new JSDOM(html,{url:"http://localhost:3000/predictions",pretendToBeVisual:true});
 const saved=new Map();
 for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,localStorage:dom.window.localStorage,navigator:dom.window.navigator,Node:dom.window.Node,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver,IS_REACT_ACT_ENVIRONMENT:true,fetch:async()=>Response.json({matches:[]})})){
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));
  Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 }
 return {dom,restore(){dom.window.close();for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key]}}};
}

test("navigation survives hydration, prediction-page replacement and root unmount",async()=>{
 const [Layout,ArchiveLink]=await Promise.all([load("../app/layout.tsx"),load("../app/components/ArchiveNavLink.tsx")]);
 const content=active=>h(Layout,null,h("main",{key:active?"archive":"predictions"},h("div",{className:"topbar"},h("nav",null,h("a",{href:"/predictions"},"AI预测"),h(ArchiveLink,{active})))));
 const tree=content(false),html="<!doctype html>"+renderToString(tree);
 const {dom,restore}=installDom(html),errors=[];
 let root;
 try{
  await act(async()=>{root=hydrateRoot(dom.window.document,tree,{onRecoverableError:error=>errors.push(error),onUncaughtError:error=>errors.push(error)})});
  await act(async()=>{root.render(content(true))});
  await act(async()=>{root.unmount()});
  assert.deepEqual(errors.map(error=>error.message),[],"React must retain ownership of navigation nodes through page replacement and unmount");
  const serverDom=new JSDOM(html);
  assert.equal(serverDom.window.document.querySelectorAll('.topbar nav a[href="/prediction-archive"]').length,1,"Archive link must exist inside navigation before client effects run");
  assert.equal(serverDom.window.document.body.children.length,1,"No detached navigation anchor outside the page");
  serverDom.window.close();
 }finally{restore()}
});

test("full prediction page keeps eleven matches visible when localStorage is full",async()=>{
 const [Home,Notice]=await Promise.all([load("../app/predictions/page.tsx"),load("../app/components/BrowserStorageNotice.tsx")]);
 const {dom,restore}=installDom(),errors=[];
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
 dom.window.localStorage.setItem("ff-records",JSON.stringify([{id:1,match:"保留的旧记录",stake:100,odd:10,result:"未中"}]));
 const originalSetItem=dom.window.Storage.prototype.setItem;
 dom.window.Storage.prototype.setItem=function(){throw new dom.window.DOMException("Storage quota exceeded","QuotaExceededError")};
 const now=new Date().toISOString(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date());
 const version={predictionId:"quota-test-version",inputSnapshotId:"test-input",baseModelVersion:"test",calibrationVersion:"none",generatedAt:now};
 const rows=Array.from({length:11},(_,index)=>({...fixture(`周一${String(index+2).padStart(3,"0")}`),...version,officialMappingStatus:"verified",salesDate:date,matchDate:"2026-09-15",marketEligibility:{}}));
 const matches=rows.map(row=>({...row,matchId:row.officialMatchId,odds:[2,3.2,3.8],marketOdds:{"胜平负":[2,3.2,3.8]},form:[],risk:"测试",tag:"测试",matchStatus:"Selling"}));
 globalThis.fetch=async url=>{
  const path=String(url);
  if(path==="/api/sporttery")return Response.json({matches,fetchedAt:now});
  if(path.startsWith("/api/prediction-versions?"))return savedVersion(rows,version,date,now);
  if(path.startsWith("/api/sporttery/results"))return Response.json({results:[]});
  if(path.startsWith("/api/prediction-snapshots"))return Response.json({snapshots:[]});
  if(path==="/api/model-audit")return Response.json({});
  throw new Error(`Unexpected request during quota regression: ${path}`);
 };
 const root=createRoot(dom.window.document.getElementById("test-root"),{onUncaughtError:error=>errors.push(error),onRecoverableError:error=>errors.push(error)});
 try{
  await act(async()=>{root.render(h("div",null,h(Home),h(Notice)));await new Promise(resolve=>setTimeout(resolve,30))});
  for(let attempt=0;attempt<50&&dom.window.document.querySelectorAll(".compact-predictions-page .daily-prediction-card").length!==11;attempt++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});
  assert.equal(dom.window.document.querySelectorAll(".compact-predictions-page .daily-prediction-card").length,11);
  assert.match(dom.window.document.querySelector(".prediction-coverage").textContent,/已生成 11 \/ 11/);
  assert.doesNotMatch(dom.window.document.querySelector(".compact-predictions-page").textContent,/官方数据已过期|官方数据读取失败/);
  assert.equal(dom.window.document.querySelector(".browser-storage-notice"),null,"Prediction route must not attempt to rewrite unrelated betting records");
  const storage=await import(await componentUrl(new URL("../app/browser-storage.ts",import.meta.url)));
  let saved;
  for(let attempt=0;attempt<50;attempt++){
   await act(async()=>{saved=await storage.readBrowserData("ff-today-predictions-v3",null)});
   if(saved?.matches?.length===11)break;
   await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});
  }
  assert.equal(saved.matches.length,11);
  assert.match(dom.window.localStorage.getItem("ff-records"),/保留的旧记录/);
  await act(async()=>root.unmount());
  assert.deepEqual(errors.map(error=>error.message),[]);
 }finally{dom.window.Storage.prototype.setItem=originalSetItem;restore()}
});

const fixture=(id,narrative="主队方向 · 升盘，多盘口较一致，偏向大球")=>({
 id,officialMatchId:`fixture-${id}`,league:"测试联赛",time:"2026-09-15 00:30:00",kickoffAt:"2026-09-15T00:30:00+08:00",home:"测试主队",away:"测试客队",
 probabilities:{home:50,draw:30,away:20},consensus:{handicap:-.25,totalLine:2.5,agreement:"较一致"},expectedGoals:{home:1.6,away:1.1},scores:[{score:"1:0",probability:16},{score:"1:1",probability:14}],missingCompanies:[],
 companies:[{companyId:2,company:"测试公司",win:2,draw:3.2,lose:3.8,handicap:-.25,total:2.5}],
 marketSignal:{direction:"主队方向",narrative,strength:1,officialOdds:[2,3.2,3.8],officialHandicap:"-1",officialHhadOdds:[3.2,3.1,2],officialHhadFair:[3,3,3],fairOdds:[2,3.33,5],hhadAvailable:true,modeledHhad:[30,30,40],modeledTotalGoals:[5,15,30,25,15,5,3,2],modeledHalfFull:[30,10,5,10,20,5,5,5,10],firstHandicap:0,handicapChange:-.25,asianHomeProbability:55,asianAwayProbability:45,asianMovement:2,overProbability:55,fitAgreement:"多盘口较一致",handicapMeaning:"测试让球"}
});
const savedVersion=(rows,version,date,fetchedAt)=>Response.json({
 status:"ready",eligible:true,snapshot:{predictionId:version.predictionId,version,date,sourceFetchedAt:fetchedAt,matches:rows}
});
const commonProps={loading:false,error:"",aiError:"",fetchedAt:"",sourceUrl:"",methodology:"测试模型",aiProvider:"",aiLoading:false,onAiReview(){}};

test("current market quotes reject ambiguous identities, changed kickoff, stale pools and different handicaps",async()=>{
 const {currentOfficialOdds}=await import(await componentUrl(new URL("../app/football-workspace.ts",import.meta.url)));
 const row={...fixture("周一001"),salesDate:"2026-10-02"},now=new Date().toISOString(),match={...row,matchId:row.officialMatchId,handicap:"-1",quoteState:"fresh",marketOdds:{"总进球数":[1,2,3,4,5,6,7,8],"让球胜平负":[2,3,4]},marketStatus:{"总进球数":"available","让球胜平负":"available"},marketEligibility:{"总进球数":{qualification:"qualified"},"让球胜平负":{qualification:"qualified"}},marketSource:{"总进球数":{observedAt:now},"让球胜平负":{observedAt:now}}};
 assert.deepEqual(currentOfficialOdds(row,[match],"总进球数"),[1,2,3,4,5,6,7,8]);
 for(const altered of [{...match,salesDate:"2026-10-03"},{...match,kickoffAt:"2026-10-02T23:00:00+08:00"},{...match,home:"同号另一队"},{...match,quoteState:"stale"},{...match,marketSource:{}},{...match,marketSource:{"总进球数":{observedAt:new Date(Date.now()-300001).toISOString()}}}]){
  assert.deepEqual(currentOfficialOdds(row,[altered],"总进球数"),[]);
 }
 assert.deepEqual(currentOfficialOdds(row,[match,match],"总进球数"),[]);
 assert.deepEqual(currentOfficialOdds(row,[match],"让球胜平负","-2"),[]);
 assert.deepEqual(currentOfficialOdds(row,[match],"让球胜平负","-1"),[2,3,4]);
});

test("prediction scroll controls target only their own match overview",async()=>{
 const Report=await load("../app/components/AiPredictionReport.tsx"),{dom,restore}=installDom(),container=dom.window.document.getElementById("test-root"),calls=[];
 const original=dom.window.HTMLElement.prototype.scrollBy;
 dom.window.HTMLElement.prototype.scrollBy=function(options){calls.push({node:this,options})};
 const root=createRoot(container);
 try{
  await act(async()=>root.render(h(Report,{...commonProps,rows:[fixture("周一001"),fixture("周一002")]})));
  const regions=container.querySelectorAll(".prediction-overview-grid");
  Object.defineProperty(regions[1],"clientWidth",{value:320});
  await act(async()=>container.querySelector('button[aria-label="周一002 查看下一类预测"]').click());
  assert.equal(calls.length,1);assert.equal(calls[0].node,regions[1]);assert.equal(calls[0].options.left,288);
  assert.equal(regions[1].children.length,5);
 }finally{await act(async()=>root.unmount());dom.window.HTMLElement.prototype.scrollBy=original;restore()}
});

for(const route of ["predictions","market-predictions"]){
 test(`${route} route reads one official batch, preserves sales-day scope and never touches betting records`,async()=>{
  const Page=await load(`../app/${route}/page.tsx`),{dom,restore}=installDom(),container=dom.window.document.getElementById("test-root"),errors=[];
  Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
  const now=new Date().toISOString(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date()),tomorrow=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date(Date.now()+86400000));
  const version={predictionId:"scoped-version",inputSnapshotId:"scoped-input",baseModelVersion:"test",calibrationVersion:"none",generatedAt:now};
  const row={...fixture("周一001"),...version,salesDate:date,kickoffAt:new Date(Date.now()+4*3600000).toISOString(),officialMappingStatus:"verified"};
  const other={...row,id:"周二001",officialMatchId:"tomorrow-fixture",salesDate:tomorrow};
  const asMatch=row=>({...row,matchId:row.officialMatchId,form:[],risk:"测试",tag:"测试",quoteState:"fresh",marketStatus:{"比分":"available","总进球数":"available"},marketEligibility:{"比分":{qualification:"qualified"},"总进球数":{qualification:"qualified"}},marketSource:{"比分":{observedAt:now},"总进球数":{observedAt:now}},marketOdds:{"比分":[7],"总进球数":[12,7,3.2,3,5,10,20,30]}});
  const originalGet=dom.window.Storage.prototype.getItem,originalSet=dom.window.Storage.prototype.setItem,recordTouches=[],requests=[];
  dom.window.Storage.prototype.getItem=function(key){if(key==="ff-records")recordTouches.push("read");return originalGet.call(this,key)};
  dom.window.Storage.prototype.setItem=function(key,value){if(key==="ff-records")recordTouches.push("write");return originalSet.call(this,key,value)};
  globalThis.fetch=async(url)=>{
   const path=String(url);requests.push(path);
   if(path==="/api/sporttery")return Response.json({matches:[asMatch(row),asMatch(other)],fetchedAt:now});
   if(path.startsWith("/api/prediction-versions?"))return savedVersion([row],version,date,now);
   if(path==="/api/model-audit")return Response.json({});
   throw Error("Unexpected independent-route request: "+path);
  };
  const root=createRoot(container,{onUncaughtError:error=>errors.push(error)});
  try{
   await act(async()=>root.render(h(Page)));
   for(let i=0;i<80&&!container.querySelector(".prediction-coverage")?.textContent.includes("已生成 1 / 1");i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});
   assert.match(container.querySelector(".prediction-coverage").textContent,/已生成 1 \/ 1/);
   assert.ok(requests.filter(path=>path==="/api/sporttery").length<=1);
   assert.equal(requests.filter(path=>path==="/api/predictions").length,0);
   assert.ok(requests.filter(path=>path.startsWith("/api/prediction-versions?")).length>=1);
   assert.deepEqual(recordTouches,[]);
   assert.equal(container.querySelector("#journal"),null);assert.equal(container.querySelector("#matches"),null);
   assert.deepEqual(errors.map(error=>error.message),[]);
  }finally{await act(async()=>root.unmount());dom.window.Storage.prototype.getItem=originalGet;dom.window.Storage.prototype.setItem=originalSet;restore()}
 });
}

test("successful empty official refresh clears matches-page selections without generating predictions",async()=>{
 const Page=await load("../app/matches/page.tsx"),{dom,restore}=installDom(),container=dom.window.document.getElementById("test-root");
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
 const now=new Date().toISOString(),row={...fixture("周一001"),form:[],tag:"测试",risk:"测试",quoteState:"fresh",matchStatus:"Selling",marketOdds:{"胜平负":[2,3,4]},marketStatus:{"胜平负":"available"},marketEligibility:{"胜平负":{qualification:"qualified"}}};
 let calls=0;
 globalThis.fetch=async(url)=>{assert.equal(String(url),"/api/sporttery");return Response.json({matches:++calls===1?[row]:[],fetchedAt:now})};
 const root=createRoot(container),flush=async predicate=>{for(let i=0;i<80&&!predicate();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});assert.ok(predicate(),container.textContent.slice(-600))};
 try{
  await act(async()=>root.render(h(Page)));await flush(()=>container.querySelector(".had-group button")?.disabled===false);
  await act(async()=>container.querySelector(".had-group button").click());assert.equal(container.querySelectorAll(".pick-list>div>span").length,1);
  await act(async()=>container.querySelector(".data-status button").click());await flush(()=>container.textContent.includes("今日暂无官方赛事")&&container.querySelectorAll(".pick-list>div>span").length===0);
  assert.equal(calls,2);assert.equal(container.querySelectorAll(".match-row").length,0);
 }finally{await act(async()=>root.unmount());restore()}
});

test("old AI review cannot overwrite a refreshed official prediction version",async()=>{
 const Page=await load("../app/predictions/page.tsx"),{dom,restore}=installDom(),container=dom.window.document.getElementById("test-root");
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
 const now=new Date().toISOString(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date()),kickoffAt=new Date(Date.now()+4*3600000).toISOString();
 let generation=0,finishReview,reviewSignal;
 const makeVersion=()=>({predictionId:"generation-"+generation,inputSnapshotId:"input-"+generation,baseModelVersion:"test",calibrationVersion:"none",generatedAt:now});
 const row=()=>({...fixture("周一001"),...makeVersion(),officialMappingStatus:"verified",salesDate:date,kickoffAt});
 globalThis.fetch=async(url,init)=>{
  const path=String(url);
  if(path==="/api/sporttery")return Response.json({matches:[{...row(),matchId:row().officialMatchId}],fetchedAt:now});
  if(path.startsWith("/api/prediction-versions?")){generation++;const version=makeVersion();return savedVersion([row()],version,date,now)}
  if(path==="/api/model-audit")return Response.json({});
  if(path.startsWith("/api/predictions/ai")){
   const body=JSON.parse(init.body);reviewSignal=init.signal;
   return new Promise(resolve=>{finishReview=()=>resolve(Response.json({version:{...body.version,reviewForPredictionId:body.version.predictionId},reports:body.reports,model:"过期复核",reviewMode:"evidence-summary-v1"}))});
  }
  throw Error("Unexpected review race request: "+path);
 };
 const root=createRoot(container),flush=async predicate=>{for(let i=0;i<100&&!predicate();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});assert.ok(predicate(),container.textContent.slice(0,1000))};
 try{
  await act(async()=>root.render(h(Page)));await flush(()=>container.textContent.includes("generation-1"));
  await act(async()=>[...container.querySelectorAll("button")].find(node=>node.textContent==="AI 复核全部比赛").click());await flush(()=>!!finishReview);
  await flush(()=>[...container.querySelectorAll("button")].some(node=>node.textContent==="刷新比赛与赔率"&&!node.disabled));
  const previousGeneration=generation;
  await act(async()=>[...container.querySelectorAll("button")].find(node=>node.textContent==="刷新比赛与赔率").click());await flush(()=>generation>previousGeneration&&container.textContent.includes(`generation-${generation}`));
  assert.equal(reviewSignal.aborted,true);
  await act(async()=>{finishReview();await new Promise(resolve=>setTimeout(resolve,30))});
  assert.match(container.textContent,new RegExp(`generation-${generation}`));assert.doesNotMatch(container.textContent,/过期复核/);
 }finally{await act(async()=>root.unmount());restore()}
});

for(const route of ["predictions","market-predictions"]){
 test(`${route} clears an interrupted force-repair state and allows another repair`,async()=>{
  const Page=await load(`../app/${route}/page.tsx`),{dom,restore}=installDom(),container=dom.window.document.getElementById("test-root");
  Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
  const now=new Date().toISOString(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date());
  const rows=["周一001","周一002"].map(id=>({...fixture(id),salesDate:date,kickoffAt:new Date(Date.now()+4*3600000).toISOString(),officialMappingStatus:"verified"}));
  let generation=0,forceCalls=0,finishOld,oldSignal;
  globalThis.fetch=async(url,init)=>{
   const path=String(url);
   if(path.startsWith("/api/sporttery"))return Response.json({matches:rows.map(row=>({...row,matchId:row.officialMatchId})),fetchedAt:now});
   if(path==="/api/model-audit")return Response.json({});
   if(path.startsWith("/api/prediction-versions?"))return Response.json({status:"not-found",eligible:false});
   if(path==="/api/predictions"){
    const force=JSON.parse(init.body).forceRefresh;
    generation++;
    const version={predictionId:`repair-${generation}`,inputSnapshotId:`input-${generation}`,baseModelVersion:"test",calibrationVersion:"none",generatedAt:now};
    const response=()=>Response.json({reports:[{...rows[0],...version}],...version,version,fetchedAt:now});
    if(force&&++forceCalls===1){oldSignal=init.signal;return new Promise(resolve=>{finishOld=()=>resolve(response())})}
    return response();
   }
   throw Error("Unexpected repair-state request: "+path);
  };
  const root=createRoot(container),flush=async predicate=>{for(let i=0;i<100&&!predicate();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});assert.ok(predicate(),container.textContent.slice(-1200))};
  const button=text=>[...container.querySelectorAll("button")].find(node=>node.textContent===text);
  try{
   await act(async()=>root.render(h(Page)));await flush(()=>button("生成当前预测")&&!button("生成当前预测").disabled);
   await act(async()=>button("生成当前预测").click());await flush(()=>button("重新抓取并核验")&&!button("重新抓取并核验").disabled);
   await act(async()=>button("重新抓取并核验").click());await flush(()=>!!finishOld);
   await act(async()=>button("刷新比赛与赔率").click());await flush(()=>button("生成当前预测")&&!button("生成当前预测").disabled);
   assert.equal(oldSignal.aborted,true);
   await act(async()=>{finishOld();await new Promise(resolve=>setTimeout(resolve,20))});
   assert.equal(button("生成当前预测").disabled,false);
   await act(async()=>button("生成当前预测").click());await flush(()=>generation===3&&button("重新抓取并核验")&&!button("重新抓取并核验").disabled);
  }finally{await act(async()=>root.unmount());restore()}
 });
}

test("sales-day clock and resumed focus reject yesterday's pending response and preserve old history",async()=>{
 const Page=await load("../app/predictions/page.tsx"),{dom,restore}=installDom(),container=dom.window.document.getElementById("test-root");
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
 const actualNow=Date.now,originalInterval=dom.window.setInterval,originalClear=dom.window.clearInterval;
 let clock=Date.parse("2026-10-02T23:59:59+08:00"),checkDate,finishYesterday,yesterdaySignal,officialCalls=0;
 Date.now=()=>clock;
 dom.window.setInterval=(callback,ms)=>{assert.equal(ms,30000);checkDate=callback;return 123};
 dom.window.clearInterval=id=>assert.equal(id,123);
 const oldDate="2026-10-02",todayDate="2026-10-03",nextDate="2026-10-04",requests=[];
 const rows=[oldDate,todayDate,nextDate].map((salesDate,index)=>({...fixture(`测试${index+1}`),officialMatchId:`day-${salesDate}`,salesDate,kickoffAt:`${salesDate}T23:59:59+08:00`,officialMappingStatus:"verified"}));
 globalThis.fetch=async(url,init)=>{
  const path=String(url);
  if(path==="/api/sporttery"){officialCalls++;return Response.json({matches:rows.map(row=>({...row,matchId:row.officialMatchId})),fetchedAt:new Date(clock).toISOString()})}
  if(path==="/api/model-audit")return Response.json({});
  if(path.startsWith("/api/prediction-versions?")){
   const date=new URL(path,"http://localhost").searchParams.get("salesDate"),row=rows.find(row=>row.salesDate===date);
   requests.push([row.officialMatchId]);
   const generatedAt=new Date(clock).toISOString(),version={predictionId:`version-${row.salesDate}`,inputSnapshotId:`input-${row.salesDate}`,baseModelVersion:"test",calibrationVersion:"none",generatedAt};
   const response=()=>savedVersion([{...row,...version}],version,date,generatedAt);
   if(row.salesDate===oldDate){yesterdaySignal=init.signal;return new Promise(resolve=>{finishYesterday=()=>resolve(response())})}
   return response();
  }
  throw Error("Unexpected midnight request: "+path);
 };
 const storage=await import(await componentUrl(new URL("../app/browser-storage.ts",import.meta.url))),config=await import(await componentUrl(new URL("../app/prediction-config.ts",import.meta.url)));
 const existing={historyRecordId:"untouched-history",predictionId:"prior-version",date:"2026-10-01",matches:[]};
 await storage.writeBrowserData(config.PREDICTION_SNAPSHOT_STORAGE_KEY,[existing]);
 const root=createRoot(container),flush=async predicate=>{for(let i=0;i<100&&!predicate();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});assert.ok(predicate(),container.textContent.slice(-1200))};
 try{
  await act(async()=>root.render(h(Page)));await flush(()=>!!finishYesterday&&!!checkDate);
  assert.deepEqual(requests,[[`day-${oldDate}`]]);
  clock=Date.parse("2026-10-03T00:00:01+08:00");
  await act(async()=>checkDate());await flush(()=>container.textContent.includes(`version-${todayDate}`));
  assert.equal(yesterdaySignal.aborted,true);assert.deepEqual(requests[1],[`day-${todayDate}`]);
  await act(async()=>{finishYesterday();await new Promise(resolve=>setTimeout(resolve,20))});
  assert.doesNotMatch(container.textContent,/version-2026-10-02/);
  let saved;
  for(let i=0;i<60&&saved?.date!==todayDate;i++)await act(async()=>{saved=await storage.readBrowserData(config.PREDICTION_STORAGE_KEY,null);await new Promise(resolve=>setTimeout(resolve,10))});
  assert.equal(saved.date,todayDate);assert.ok(saved.matches.every(row=>row.salesDate===todayDate));
  clock=Date.parse("2026-10-04T00:01:00+08:00");
  await act(async()=>dom.window.dispatchEvent(new dom.window.Event("focus")));await flush(()=>container.textContent.includes(`version-${nextDate}`));
  assert.deepEqual(requests.at(-1),[`day-${nextDate}`]);assert.equal(officialCalls,3);
  let history;
  for(let i=0;i<60&&!history?.some(row=>row.date===nextDate);i++)await act(async()=>{history=await storage.readBrowserData(config.PREDICTION_SNAPSHOT_STORAGE_KEY,[]);await new Promise(resolve=>setTimeout(resolve,10))});
  assert.deepEqual(history.find(row=>row.historyRecordId===existing.historyRecordId),existing);
  assert.ok(history.filter(row=>row.historyRecordId!==existing.historyRecordId).every(row=>row.matches.every(match=>match.salesDate===row.date)));
 }finally{await act(async()=>root.unmount());Date.now=actualNow;dom.window.setInterval=originalInterval;dom.window.clearInterval=originalClear;restore()}
});

test("same official ID and date with changed kickoff is excluded from the current prediction",async()=>{
 const Page=await load("../app/predictions/page.tsx"),{dom,restore}=installDom(),container=dom.window.document.getElementById("test-root");
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
 const now=new Date().toISOString(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date()),version={predictionId:"changed-kickoff",inputSnapshotId:"input",baseModelVersion:"test",calibrationVersion:"none",generatedAt:now},row={...fixture("周一001"),...version,salesDate:date,officialMappingStatus:"verified"};
 globalThis.fetch=async(url)=>String(url)==="/api/sporttery"?Response.json({matches:[{...row,matchId:row.officialMatchId,kickoffAt:new Date(Date.now()+4*3600000).toISOString()}],fetchedAt:now}):String(url)==="/api/model-audit"?Response.json({}):String(url).startsWith("/api/prediction-versions?")?Response.json({status:"not-found",eligible:false}):Response.json({reports:[row],...version,version,fetchedAt:now});
 const root=createRoot(container);
 try{
  await act(async()=>root.render(h(Page)));
  for(let i=0;i<80&&![...container.querySelectorAll("button")].some(button=>button.textContent==="生成当前预测");i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});
  await act(async()=>[...container.querySelectorAll("button")].find(button=>button.textContent==="生成当前预测").click());
  for(let i=0;i<80&&!container.querySelector(".prediction-coverage");i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});
  assert.match(container.querySelector(".prediction-coverage").textContent,/已生成 0 \/ 1/);assert.equal(container.querySelectorAll(".daily-prediction-card").length,0);
 }finally{await act(async()=>root.unmount());restore()}
});

test("prediction page waits for a queued generation without saving zero coverage or replacing it with a browser baseline",async()=>{
 const Home=await load("../app/predictions/page.tsx");
 const {dom,restore}=installDom(),errors=[],container=dom.window.document.getElementById("test-root");
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
 const now=new Date().toISOString(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date());
 const version={predictionId:"queued-page-version",inputSnapshotId:"queued-input",baseModelVersion:"test",calibrationVersion:"none",generatedAt:now};
 const rows=[{...fixture("周一001"),...version,officialMappingStatus:"verified",salesDate:date,marketEligibility:{}}];
 const matches=rows.map(row=>({...row,matchId:row.officialMatchId,odds:[2,3.2,3.8],marketOdds:{"胜平负":[2,3.2,3.8]},form:[],risk:"测试",tag:"测试",matchStatus:"Selling"}));
 let jobStarted=false,complete;
 globalThis.fetch=async(url,init)=>{
  const path=String(url);
  if(path==="/api/sporttery")return Response.json({matches,fetchedAt:now});
  if(path.startsWith("/api/prediction-versions?"))return Response.json({status:"not-found",eligible:false});
  if(path==="/api/predictions")return Response.json({status:"queued",jobId:"page-job"},{status:202});
  if(path==="/api/prediction-jobs?jobId=page-job"){
   jobStarted=true;return new Promise((resolve,reject)=>{complete=()=>resolve(Response.json({jobId:"page-job",reports:rows,...version,version,fetchedAt:now,unavailableOfficialMatches:[]}));init.signal.addEventListener("abort",()=>reject(init.signal.reason),{once:true})});
  }
  throw Error(`Unexpected queued page request: ${path}`);
 };
 const root=createRoot(container,{onUncaughtError:error=>errors.push(error),onRecoverableError:error=>errors.push(error)});
 const storage=await import(await componentUrl(new URL("../app/browser-storage.ts",import.meta.url)));
 const flush=async predicate=>{for(let i=0;i<120&&!predicate();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});assert.ok(predicate(),JSON.stringify({errors:errors.map(error=>error.message),text:container.textContent.slice(0,1800)}))};
 try{
  await act(async()=>root.render(h(Home)));
  await flush(()=>[...container.querySelectorAll("button")].some(button=>button.textContent==="生成当前预测"));
  await act(async()=>[...container.querySelectorAll("button")].find(button=>button.textContent==="生成当前预测").click());
  await flush(()=>jobStarted);
  assert.equal(container.querySelectorAll(".daily-prediction-card").length,0);
  assert.equal(container.querySelector(".prediction-coverage"),null,"A pending job is not a zero-predictions coverage result");
  assert.equal(await storage.readBrowserData("ff-today-predictions-v3",null),null);
  assert.doesNotMatch(container.textContent,/已切换为已核验体彩|新预测已暂停/);
  await act(async()=>complete());
  await flush(()=>container.querySelectorAll(".compact-predictions-page .daily-prediction-card").length===1);
  assert.match(container.querySelector(".prediction-coverage").textContent,/已生成 1 \/ 1/);
  let saved;
  for(let i=0;i<60&&!saved?.matches?.length;i++)await act(async()=>{saved=await storage.readBrowserData("ff-today-predictions-v3",null);await new Promise(resolve=>setTimeout(resolve,10))});
  assert.equal(saved.predictionId,version.predictionId);assert.equal(saved.matches.length,1);
  assert.deepEqual(errors.map(error=>error.message),[]);
 }finally{await act(async()=>root.unmount());restore()}
});

test("offline consumer is visible and checking status never submits a prediction",async()=>{
 const Home=await load("../app/predictions/page.tsx");
 const {dom,restore}=installDom(),container=dom.window.document.getElementById("test-root");
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
 const date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date());
 const now=new Date().toISOString();let reads=0,posts=0,available=false;
 globalThis.fetch=async(url,options={})=>{
  const route=String(url);if(options.method==="POST")posts++;
  if(route==="/api/sporttery")return Response.json({matches:[{...fixture("周一001"),salesDate:date,matchDate:date,officialMatchId:"1",matchId:"1",odds:[2,3,4],form:[],tag:"测试",risk:"测试",matchStatus:"Selling"}],fetchedAt:now});
  if(route.startsWith("/api/prediction-versions")){reads++;return Response.json({status:"not-found",eligible:false,submission:{available,code:available?null:"INDEPENDENT_CONSUMER_UNAVAILABLE"}})}
  if(route==="/api/model-audit"||route==="/api/calibration")return Response.json({});
  throw Error(`Unexpected read ${route}`);
 };
 const root=createRoot(container),button=text=>[...container.querySelectorAll("button")].find(b=>b.textContent===text);
 const flush=async condition=>{for(let i=0;i<80&&!condition();i++)await act(async()=>{await new Promise(r=>setTimeout(r,10))});assert.ok(condition())};
 try{
  await act(async()=>root.render(h(Home)));
  await flush(()=>button("生成当前预测")&&container.textContent.includes("后台预测执行程序未就绪"));
  assert.equal(button("生成当前预测").disabled,true);
  const before=reads;available=true;
  await act(async()=>button("检查状态 / 读取结果").click());
  await flush(()=>reads>before&&!button("生成当前预测").disabled);
  assert.equal(posts,0);
  assert.doesNotMatch(container.textContent,/等待后台采集/);
 }finally{await act(async()=>root.unmount());restore()}
});

test("closing a pending single-match review cannot publish its late result in another match",async()=>{
 const Home=await load("../app/page.tsx");
 const {dom,restore}=installDom(),errors=[],container=dom.window.document.getElementById("test-root");
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
 const now=new Date().toISOString(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date());
 const version={predictionId:"detail-version",inputSnapshotId:"detail-input",baseModelVersion:"test",calibrationVersion:"none",generatedAt:now};
 const matches=["周一001","周一002"].map(id=>({...fixture(id),salesDate:date,matchId:`fixture-${id}`,form:[],tag:"测试",risk:"测试",matchStatus:"Selling"}));
 const report={...matches[0],...version,officialMappingStatus:"verified",contextProof:{synthetic:true},modelInput:{matchContext:{status:"unavailable"}}};
 let predictionCalls=0,jobStarted=false,finishOld,analysisCalls=0;
 globalThis.fetch=async(url)=>{
  const path=String(url);
  if(path==="/api/sporttery")return Response.json({matches,fetchedAt:now});
  if(path.startsWith("/api/sporttery/detail"))return Response.json({});
  if(path==="/api/predictions"){predictionCalls++;return Response.json({status:"queued",jobId:"detail-job"},{status:202})}
  if(path==="/api/prediction-jobs?jobId=detail-job"){jobStarted=true;return new Promise(resolve=>{finishOld=()=>resolve(Response.json({reports:[report],jobId:"detail-job",...version,version,fetchedAt:now}))})}
  if(path==="/api/analyze"){analysisCalls++;return Response.json({text:"不应出现在另一场的旧结果"})}
  throw Error(`Unexpected detail review request: ${path}`);
 };
 const root=createRoot(container,{onUncaughtError:error=>errors.push(error),onRecoverableError:error=>errors.push(error)});
 const flush=async predicate=>{for(let i=0;i<120&&!predicate();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});assert.ok(predicate(),errors.map(error=>error.message).join(";"))};
 try{
  await act(async()=>root.render(h(Home)));
  await flush(()=>container.querySelectorAll(".detail-entry").length===2);
  assert.equal(predictionCalls,0,"Matches page must not generate predictions before explicit evidence review");
  await act(async()=>container.querySelectorAll(".detail-entry")[0].click());
  const review=()=>[...container.querySelectorAll(".ai-action button")][0];
  await act(async()=>review().click());
  await flush(()=>jobStarted);
  await act(async()=>container.querySelector('button[aria-label="关闭"]').click());
  await act(async()=>container.querySelectorAll(".detail-entry")[1].click());
  assert.equal(review().disabled,false,"Cancellation must not leave the next detail stuck loading");
  await act(async()=>{finishOld();await new Promise(resolve=>setTimeout(resolve,30))});
  assert.equal(analysisCalls,0,"The cancelled match must not proceed to AI analysis");
  assert.equal(container.querySelector(".ai-result"),null);
  assert.deepEqual(errors.map(error=>error.message),[]);
 }finally{await act(async()=>root.unmount());restore()}
});

test("today recommendations refresh official SP on generation, show net ranges and preserve prior results on fetch failure",async()=>{
 const Recommendations=await load("../app/components/TodayRecommendations.tsx");
 const {dom,restore}=installDom(),errors=[],container=dom.window.document.getElementById("test-root");
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
 const now=new Date().toISOString(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date()),kickoff=new Date(Date.now()+4*3600000).toISOString().replace(/\.\d{3}Z$/,"Z");
 const scores=Array.from({length:169},(_,index)=>{const score=`${Math.floor(index/13)}:${index%13}`;return {score,probability:score==="1:0"?40:score==="0:0"?30:30/167};});
 assert.equal(scores.length,169);assert.ok(Math.abs(scores.reduce((sum,point)=>sum+point.probability,0)-100)<1e-8);
 const matches=[1,2].map(i=>({id:`周一00${i}`,officialMatchId:`returns-${i}`,predictionId:"returns-version",salesDate:date,matchDate:date,kickoffAt:kickoff,time:kickoff,home:`主队${i}`,away:`客队${i}`,league:"测试联赛",officialMappingStatus:"verified",sourceFetchedAt:now,confidence:85,completeness:10,singleModel:false,combinedScores:scores,fullScoreDistribution:scores}));
 assert.equal(dom.window.localStorage.getItem("ff-today-predictions-v3"),null);
 let calls=0,fail=false,missing=false;
 globalThis.fetch=async url=>{
  const path=String(url);
  if(path.startsWith("/api/prediction-versions?"))return Response.json({status:"ready",eligible:true,expiresAt:new Date(Date.now()+300000).toISOString(),snapshot:{date,predictionId:"returns-version",matches}});
  if(path==="/api/sporttery"){
   calls++;if(fail)return Response.json({error:"官方接口暂不可用"},{status:502});
   return Response.json({fetchedAt:new Date().toISOString(),matches:matches.map((match,i)=>{
    const odds=Array(31).fill(0);odds[0]=calls===1?99:i===0?2:6;odds[13]=missing&&i===0?0:calls===1?88:i===0?3:10;
    return {...match,matchStatus:"Selling",marketOdds:{"比分":odds},marketEligibility:{"比分":{marketCode:"CRS",qualification:"qualified",salesStatus:"Selling",allowedPassCounts:[1,2,3,4],cutoffAt:kickoff}}};
   })});
  }
  if(path.startsWith("/api/prediction-snapshots"))return Response.json({snapshots:[]});
  if(path.startsWith("/api/sporttery/results"))return Response.json({results:[]});
  if(path==="/api/purchase-trials")return Response.json({trials:[]});
  throw new Error(`Unexpected request: ${path}`);
 };
 const root=createRoot(container,{onUncaughtError:error=>errors.push(error),onRecoverableError:error=>errors.push(error)});
 const flush=async predicate=>{for(let i=0;i<60&&!predicate();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,15))});assert.ok(predicate(),`Expected UI state did not settle: ${container.textContent.slice(0,700)}`)};
 try{
  const storage=await import(await componentUrl(new URL("../app/browser-storage.ts",import.meta.url)));
  assert.equal(await storage.readBrowserData("ff-today-predictions-v3",null),null,"A new device has no prediction history");
  await act(async()=>root.render(h(Recommendations)));
  await flush(()=>container.querySelector(".generate-row button")?.disabled===false);
  const before=calls;
  await act(async()=>container.querySelector(".generate-row button").click());
  await flush(()=>!!container.querySelector(".recommendation-return-panel"));
  assert.equal(calls,before+1,"Generate must fetch current official odds, not only use the mount-time cache");
  const text=container.querySelector(".combination-card").textContent;
  assert.match(text,/体彩 SP 2\.00/);assert.match(text,/体彩 SP 10\.00/);assert.doesNotMatch(text,/SP 99\.00/);
  assert.match(text,/共 4 注/);assert.match(text,/本组总投入¥8\.00/);
  assert.match(text,/最高盈利（中奖时）¥52\.00/);assert.match(text,/最低盈利（中奖时）¥16\.00/);assert.match(text,/未中奖时净亏损¥-8\.00/);
  fail=true;
  await act(async()=>container.querySelector(".generate-row button").click());
  await flush(()=>!!container.querySelector('[role="alert"]'));
  assert.match(container.querySelector('[role="alert"]').textContent,/获取失败.*未重新生成/);
  assert.match(container.querySelector(".recommendation-return-panel").textContent,/¥52\.00/);
  fail=false;missing=true;
  await act(async()=>container.querySelector(".generate-row button").click());
  await flush(()=>container.querySelector('[role="alert"]')?.textContent.includes("没有符合返奖约束"));
  assert.match(container.querySelector('[role="alert"]').textContent,/返奖约束、收益余量与压力检查/);
  assert.equal(container.querySelectorAll(".recommendation-return-panel").length,0,"Incomplete odds must not produce a recommended ticket");
  await act(async()=>container.querySelector('input[name="score-count"]').click());
  assert.equal(container.querySelectorAll(".combination-card").length,0,"Changing filters must clear old financial estimates");
  await act(async()=>container.querySelector('#purchase-view-doubling').click());
  assert.equal(container.querySelector('#purchase-panel-original').hidden,true);
  assert.equal(container.querySelector('#purchase-panel-doubling').hidden,false);
  assert.match(container.querySelector('#purchase-panel-doubling').textContent,/每种方式独立从1倍开始/);
  await act(async()=>container.querySelector('#purchase-view-doubling').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true})));
  assert.equal(container.querySelector('#purchase-panel-original').hidden,false);
  assert.equal(container.querySelector('#purchase-view-original').getAttribute('aria-selected'),'true');
  await act(async()=>root.unmount());
  assert.deepEqual(errors.map(error=>error.message),[]);
 }finally{await act(async()=>root.unmount());restore()}
});

test("doubling summary renders scaled historical money and tolerates missing stakes",async()=>{
 const Summary=await load("../app/components/PurchaseDoublingSummary.tsx");
 const rows=["lost","lost","won","pending"].map((status,index)=>({snapshotId:`test-${index}`,date:`2026-09-${20+index}`,generatedAt:`2026-09-${20+index}T17:00:00+08:00`,plan:{id:"total-double-2",status,stake:index===3?undefined:8,simulatedReturn:status==="won"?20:0,items:[{matchId:"周日001",home:"主队",away:"客队",pick:"2球",marketName:"总进球"}]}}));
 const html=renderToString(h(Summary,{history:{"total-double-2":{rows}},slot:"1700",loading:false}));
 const doc=new JSDOM(html).window.document;
 assert.match(doc.body.textContent,/8元 → 16元 → 24元 → 32元/);
 assert.match(doc.body.textContent,/按1、2、3、4倍依次递增/);
 assert.doesNotMatch(doc.body.textContent,/翻倍/);
 assert.match(doc.body.textContent,/-¥48\.00/);
 assert.match(doc.body.textContent,/\+¥60\.00/);
 assert.match(doc.body.textContent,/\+¥12\.00/);
 assert.match(doc.body.textContent,/金额待补/);
 assert.equal(doc.querySelectorAll('tbody tr').length>3,true);
});

test("prediction and market views can refresh all matches, filter, clear and unmount without DOM errors",async()=>{
 const [AiReport,MarketTable]=await Promise.all([load("../app/components/AiPredictionReport.tsx"),load("../app/components/MarketPredictionTable.tsx")]);
 const {dom,restore}=installDom(),errors=[],container=dom.window.document.getElementById("test-root");
 const root=createRoot(container,{onUncaughtError:error=>errors.push(error),onRecoverableError:error=>errors.push(error)});
 const render=async(rows,loading=false)=>act(async()=>root.render(h("main",null,h(AiReport,{...commonProps,rows,loading}),h(MarketTable,{...commonProps,rows,loading}))));
 try{
  await render([fixture("周一003"),fixture("周一004")]);
  assert.equal(container.querySelectorAll(".daily-prediction-card").length,2);
  const rows=Array.from({length:11},(_,index)=>fixture(`周一${String(index+2).padStart(3,"0")}`));
  await render(rows);
  assert.equal(container.querySelectorAll(".daily-prediction-card").length,11);
  assert.equal(container.querySelectorAll(".market-forecast-table tbody tr").length,11);
  assert.equal(container.querySelector(".forecast-league").dataset.tone,String(Array.from("测试联赛").reduce((sum,char)=>sum+char.charCodeAt(0),0)%12));
  assert.match(container.querySelector(".forecast-expectation>span").textContent,/主队方向/);
  assert.equal(container.querySelector(".forecast-expectation mark").className,"forecast-key-home");
  const scoreTab=[...container.querySelectorAll(".forecast-view-tabs button")].find(button=>button.textContent==="比分");
  await act(async()=>scoreTab.click());
  assert.ok(container.querySelector(".forecast-view-score"));
  const filter=container.querySelector(".market-prediction-filters select");
  await act(async()=>{filter.value="测试联赛";filter.dispatchEvent(new dom.window.Event("change",{bubbles:true}))});
  await render([fixture("周一003","客队方向 · 降盘，部分一致，偏向小球")]);
  assert.equal(container.querySelectorAll(".market-forecast-table tbody tr").length,1);
  assert.equal(container.querySelector(".forecast-expectation mark").className,"forecast-key-away");
  await render([],true);
  assert.equal(container.querySelectorAll(".daily-prediction-card").length,0);
  await render(rows);
  assert.equal(container.querySelectorAll(".daily-prediction-card").length,11);
  await act(async()=>root.unmount());
  assert.deepEqual(errors.map(error=>error.message),[]);
  const source=await readFile(new URL("../app/components/MarketPredictionTable.tsx",import.meta.url),"utf8");
  assert.doesNotMatch(source,/replaceChildren|document\.querySelectorAll|document\.createElement/,"Highlight markup must be owned by React, not rewritten after render");
 }finally{restore()}
});


// Exercise real React effects/events with two actual batches for one shared ticket.
function recommendationArchiveFixture() {
 const date=new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10);
 const items=[1,2].map(index=>({
  matchId:"周四00"+index,officialMatchId:"dom-archive-"+index,salesDate:date,matchDate:date,
  kickoffAt:date+"T23:00:00+08:00",home:"留档主队"+index,away:"留档客队"+index,league:"DOM历史联赛",
  market:"score",marketName:"比分",pick:"1:0",probability:70,odd:3,picks:[{pick:"1:0",probability:70,odd:3}],
 }));
 const plan={id:"score-single-2",title:"比分单选2串1",rule:"每场1个比分 · 2串1",status:"pending",passName:"2串1",items,combinedOdd:9,estimatedProbability:.49,stake:2,betCount:1,theoreticalReturn:18,decision:{objective:"DOM历史目标",targetNetProfit:20,targetMet:true,maximumLoss:2}};
 const set=(slot,generatedAt,snapshotId)=>({
  version:18,date,scheduledTime:slot,generatedAt,capturedAt:generatedAt,completedAt:generatedAt,source:"DOM测试真实批次",
  snapshotId,decisionPolicy:"dom-fixed-policy",baseModelVersion:"dom-base-v1",calibrationVersion:"dom-cal-v1",plans:[structuredClone(plan)],
 });
 const early=set("17:00",date+"T09:00:00.000Z","purchase-dom-"+date+"-1700");
 const late=set("21:00",date+"T13:00:00.000Z","purchase-dom-"+date+"-2100");
 const loadedTrial=set("17:00",date+"T10:00:00.000Z","manual-trial-dom-loaded");
 loadedTrial.source="DOM测试保存研究试算";
 const results=items.map(item=>({id:item.matchId,matchId:item.officialMatchId,officialMatchId:item.officialMatchId,date,matchDate:date,fullScore:"1:0",scoreResult:"1:0",hadResult:"胜",status:"settled"}));
 return {date,early,late,loadedTrial,results};
}

async function mountRecommendationArchive({savedTrial=false,livePrediction=false,independentPage=false,historyReadFailure=null}={}) {
 const Recommendations=await load(independentPage?"../app/recommendations/page.tsx":"../app/components/TodayRecommendations.tsx");
 const {dom,restore}=installDom(),errors=[],container=dom.window.document.getElementById("test-root");
 if(independentPage)dom.reconfigure({url:"http://localhost:3000/recommendations"});
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
 const recordAccess=[],storageRestorers=[];
 if(independentPage){
  dom.window.localStorage.setItem("ff-records",JSON.stringify([{id:1,match:"独立页面必须不读取的记录",stake:8}]));
  for(const [prototype,methods] of [[dom.window.Storage.prototype,{getItem:0,setItem:0,removeItem:0,clear:null}],[IDBObjectStore.prototype,{get:0,put:1,add:1,delete:0,clear:null}]]){
   for(const [method,keyIndex] of Object.entries(methods)){
    const original=prototype[method];
    prototype[method]=function(...args){if(keyIndex===null||args[keyIndex]==="ff-records")recordAccess.push(method);return original.apply(this,args);};
    storageRestorers.push(()=>{prototype[method]=original;});
   }
  }
 }
 const restorePage=()=>{storageRestorers.reverse().forEach(restoreMethod=>restoreMethod());restore();};
 const fixture=recommendationArchiveFixture();
 const archive={snapshots:[],purchasePlanSnapshots:[{planSet:fixture.early},{planSet:fixture.late}],resultCache:Object.fromEntries(fixture.results.map(result=>[result.matchId+"|"+result.date,result])),captureAttempts:[]};
 const archiveBefore=JSON.stringify(archive),savedBodies=[],requests=[];
 let trials=savedTrial?[structuredClone(fixture.loadedTrial)]:[];
 const now=new Date().toISOString(),date=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
 const kickoff=new Date(Date.now()+4*3600000).toISOString().replace(/\.\d{3}Z$/,"Z");
 const scores=Array.from({length:169},(_,index)=>{const score=Math.floor(index/13)+":"+index%13;return {score,probability:score==="1:0"?70:score==="0:0"?20:10/167};});
 const predictions=[1,2].map(index=>({
  id:"周四10"+index,officialMatchId:"dom-live-"+index,predictionId:"dom-live-prediction",salesDate:date,matchDate:date,kickoffAt:kickoff,time:kickoff,
  home:"实时主队"+index,away:"实时客队"+index,league:"DOM实时联赛",officialMappingStatus:"verified",sourceFetchedAt:now,completeness:10,
  combinedScores:scores,fullScoreDistribution:scores,handicap:"",
 }));
 const officials=predictions.map(match=>{
  const odds=Array(31).fill(9);odds[0]=5;odds[13]=3;
  return {...match,matchStatus:"Selling",marketOdds:{"比分":odds},marketEligibility:{"比分":{marketCode:"CRS",qualification:"qualified",salesStatus:"Selling",allowedPassCounts:[1,2,3,4],cutoffAt:kickoff}}};
 });
 globalThis.fetch=async(url,options={})=>{
  const requestPath=String(url);requests.push({path:requestPath,method:options.method||"GET"});
  if(requestPath.startsWith("/api/prediction-versions?"))return Response.json(livePrediction?{status:"ready",eligible:true,expiresAt:new Date(Date.now()+300000).toISOString(),snapshot:{date,predictionId:"dom-live-prediction",matches:predictions}}:{status:"not-found",eligible:false});
  if(historyReadFailure?.path===requestPath && options.method!=="POST"){
   const failure=historyReadFailure.kind;
   if(failure==="network")throw new TypeError("isolated network failure");
   if(failure==="invalid-json")return new Response("<html>unavailable</html>",{status:200});
   if(failure==="malformed")return Response.json({});
   return Response.json({error:"isolated read failure"},{status:failure});
  }
  if(requestPath==="/api/prediction-snapshots?view=recommendations")return Response.json(archive);
  if(requestPath==="/api/purchase-trials"){
   if(options.method==="POST"){
    const trial=JSON.parse(options.body);savedBodies.push(structuredClone(trial));
    trials=[trial,...trials.filter(row=>row.snapshotId!==trial.snapshotId)];
    return Response.json({trial});
   }
   return Response.json({trials});
  }
  if(requestPath.startsWith("/api/sporttery/results?")){
   const requestedDate=new URL(requestPath,"http://localhost").searchParams.get("date");
   return Response.json({results:fixture.results.filter(result=>result.date===requestedDate)});
  }
  if(requestPath==="/api/sporttery")return Response.json({matches:officials,fetchedAt:new Date().toISOString()});
  throw new Error("Unexpected request in recommendation archive regression: "+requestPath);
 };
 const root=createRoot(container,{onUncaughtError:error=>errors.push(error),onRecoverableError:error=>errors.push(error)});
 const flush=async(predicate,message="Expected recommendation DOM state")=>{
  for(let attempt=0;attempt<80&&!predicate();attempt++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,15))});
  assert.ok(predicate(),message+": "+container.textContent.slice(0,1000));
 };
 try{
  if(livePrediction){
   const storage=await import(await componentUrl(new URL("../app/browser-storage.ts",import.meta.url)));
   await storage.writeBrowserData("ff-today-predictions-v3",{date,predictionId:"dom-live-prediction",matches:predictions});
  }
  await act(async()=>root.render(h(Recommendations)));
  await flush(()=>{const select=container.querySelector('select[aria-label="选择预购买方案快照"]');return select&&!select.disabled&&select.value;});
 }catch(error){await act(async()=>root.unmount());restorePage();throw error}
 const select=()=>container.querySelector('select[aria-label="选择预购买方案快照"]');
 const button=text=>[...container.querySelectorAll(".daily-purchase-panel button")].find(node=>node.textContent===text);
 const choose=async id=>{await act(async()=>{select().value=id;select().dispatchEvent(new dom.window.Event("change",{bubbles:true}))});await flush(()=>select()?.value===id&&!select().disabled);};
 const cash=label=>[...container.querySelectorAll(".purchase-kanban>div")].find(node=>node.querySelector("span").textContent===label)?.textContent;
 return {dom,container,fixture,select,button,choose,cash,flush,savedBodies,requests,archive,archiveBefore,recordAccess,
  setHistoryReadFailure(failure){historyReadFailure=failure;},
  async dispose(){await act(async()=>root.unmount());restorePage();assert.deepEqual(errors.map(error=>error.message),[]);}
 };
}

test("saved-trial read failures remain explicit across summary tabs and recover without hiding formal history",async()=>{
 for(const kind of [401,503,"network","invalid-json","malformed"]){
  const ui=await mountRecommendationArchive({savedTrial:true,historyReadFailure:{path:"/api/purchase-trials",kind}});
  try{
   const alert=()=>[...ui.container.querySelectorAll('[role="alert"]')].find(node=>node.textContent.includes("试算记录"));
   assert.ok(alert(),`Read failure ${kind} must not masquerade as an empty trial list`);
   assert.match(alert().textContent,kind===401?/尚未登录/:/读取失败/);
   assert.equal(ui.select().value,ui.fixture.early.snapshotId);
   assert.match(ui.cash("模拟净收益"),/\+¥16\.00/);
   await act(async()=>ui.button("倍投计算").click());
   assert.equal(alert().closest("[hidden]"),null,"Read completeness notice must remain visible in the doubling view");
   ui.setHistoryReadFailure(null);
   await act(async()=>ui.button("刷新快照").click());
   await ui.flush(()=>!alert()&&[...ui.select().options].some(option=>option.value===ui.fixture.loadedTrial.snapshotId),"Recovered trials and cleared warning");
   assert.equal(JSON.stringify(ui.archive),ui.archiveBefore);
   assert.equal(ui.requests.some(request=>request.method!=="GET"),false);
  }finally{await ui.dispose()}
 }
});

test("formal archive read failures cannot claim a missing batch or fully loaded history",async()=>{
 for(const kind of [503,"network","invalid-json","malformed"]){
  const ui=await mountRecommendationArchive({savedTrial:true});
  try{
   ui.setHistoryReadFailure({path:"/api/prediction-snapshots?view=recommendations",kind});
   await act(async()=>ui.button("刷新快照").click());
   await ui.flush(()=>!ui.button("刷新快照").disabled&&ui.container.textContent.includes("尚无法确认该日期与批次"));
   const alert=[...ui.container.querySelectorAll('[role="alert"]')].find(node=>node.textContent.includes("正式快照历史读取失败"));
   assert.ok(alert);
   assert.doesNotMatch(ui.container.textContent,/该彩票日期没有已保存的/);
   assert.ok([...ui.select().options].some(option=>option.value===ui.fixture.loadedTrial.snapshotId),"Successful personal history remains selectable");
   await act(async()=>ui.button("倍投计算").click());
   assert.equal(alert.closest("[hidden]"),null);
   ui.setHistoryReadFailure(null);
   await act(async()=>ui.button("刷新快照").click());
   await ui.flush(()=>ui.select()?.value===ui.fixture.early.snapshotId&&!ui.select().disabled&&!ui.container.textContent.includes("正式快照历史读取失败"));
   assert.equal(JSON.stringify(ui.archive),ui.archiveBefore);
   assert.equal(ui.requests.some(request=>request.method!=="GET"),false);
  }finally{await ui.dispose()}
 }
});

test("independent recommendations page reads and settles history without Home requests or record access",async()=>{
 const ui=await mountRecommendationArchive({independentPage:true});
 try{
  assert.equal(ui.container.querySelector("main").className,"view-recommendations");
  const navigation=ui.container.querySelector('nav[aria-label="主要页面"]');
  assert.equal(navigation.querySelectorAll("a").length,5);
  assert.equal(navigation.querySelector('[aria-current="page"]').getAttribute("href"),"/recommendations");
  assert.equal(ui.container.querySelectorAll(".site-footer").length,1);
  assert.equal(ui.select().value,ui.fixture.early.snapshotId);
  assert.match(ui.cash("模拟净收益"),/\+¥16\.00/);
  assert.ok(ui.requests.some(request=>request.path==="/api/prediction-snapshots?view=recommendations"));
  assert.ok(ui.requests.every(request=>request.path!=="/api/sporttery"&&request.path!=="/api/predictions"&&request.path!=="/api/model-audit"),"Without a valid current prediction, reading archived tickets must not start Home's live-data or prediction chain");
  assert.deepEqual(ui.recordAccess,[],"Recommendation navigation must neither read nor mutate ff-records in either browser storage implementation");
  assert.equal(ui.requests.some(request=>request.method!=="GET"),false);
  assert.equal(JSON.stringify(ui.archive),ui.archiveBefore);
 }finally{await ui.dispose()}
});

test("visiting prediction tabs reads the saved version and only explicit generation submits a batch",async()=>{
 const {dom,restore}=installDom();
 const originalFetch=globalThis.fetch;
 const requests=[];
 const date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 const match={id:"周六001",matchId:"official-1",officialMatchId:"official-1",salesDate:date,matchDate:date,kickoffAt:`${date}T23:00:00+08:00`,home:"甲",away:"乙",league:"测试联赛",time:"23:00"};
 globalThis.fetch=async(input,options={})=>{
  const path=String(input);
  requests.push({path,method:options.method||"GET",body:options.body});
  if(path.startsWith("/api/prediction-versions?"))return Response.json({status:"not-found",eligible:false});
  if(path==="/api/predictions")return new Promise(()=>{});
  throw new Error(`Unexpected prediction read request: ${path}`);
 };
 const {usePredictionWorkspace}=await import(await componentUrl(new URL("../app/hooks/usePredictionWorkspace.ts",import.meta.url)));
 const official={liveMatches:[match],allMatches:[match],dataLoading:false,dataState:"success",dataMeta:{fetchedAt:new Date().toISOString()},repairNotice:"",setRepairNotice(){},repairMissingMatches:async()=>({ok:true,matches:[match]}),refreshSporttery:async()=>{}};
 function Harness(){const state=usePredictionWorkspace(official,"market-predictions");return h("button",{onClick:state.generatePredictionNow},state.predictionError||"loading")}
 const root=createRoot(dom.window.document.getElementById("test-root"));
 try{
  await act(async()=>root.render(h(Harness)));
  for(let i=0;i<20&&!dom.window.document.body.textContent.includes("尚无合格");i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,5))});
  assert.match(dom.window.document.body.textContent,/尚无合格的服务端预测/);
  assert.equal(requests.filter(row=>row.method==="POST").length,0,"Page visit must never submit a batch");
  await act(async()=>dom.window.document.querySelector("button").click());
  assert.equal(requests.filter(row=>row.method==="POST"&&row.path==="/api/predictions").length,1,"Only an explicit click submits");
  assert.equal(JSON.parse(requests.find(row=>row.method==="POST").body).forceRefresh,false,"Normal generation must permit same-input task reuse");
 }finally{await act(async()=>root.unmount());globalThis.fetch=originalFetch;restore()}
});

test("prediction page distinguishes sign-in, read failure, and failed generation without browser replacement",async()=>{
 const Page=await load("../app/predictions/page.tsx");
 const date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date());
 const now=new Date().toISOString();
 const match={...fixture("周六001"),salesDate:date,matchDate:date,kickoffAt:new Date(Date.now()+4*3600000).toISOString(),matchId:"fixture-周六001",odds:[2,3,4],matchStatus:"Selling"};
 for(const scenario of ["sign-in","read-failed","generation-failed"]){
  const {dom,restore}=installDom(),container=dom.window.document.getElementById("test-root"),requests=[];
  globalThis.fetch=async(url,options={})=>{
   const path=String(url);requests.push({path,method:options.method||"GET"});
   if(path==="/api/sporttery")return Response.json({matches:[match],fetchedAt:now});
   if(path==="/api/model-audit")return Response.json({});
   if(path.startsWith("/api/prediction-versions?"))return scenario==="sign-in"?new Response(null,{status:401}):scenario==="read-failed"?new Response(null,{status:503}):Response.json({status:"not-found",eligible:false});
   if(path==="/api/predictions")return Response.json({error:"后台消费者未就绪"},{status:503});
   throw Error(`Unexpected failure-state request: ${path}`);
  };
  const root=createRoot(container);
  const flush=async predicate=>{for(let i=0;i<80&&!predicate();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,15))});assert.ok(predicate(),container.textContent.slice(0,700))};
  const generate=()=>[...container.querySelectorAll("button")].find(button=>button.textContent==="生成当前预测");
  try{
   await act(async()=>root.render(h(Page)));
   await flush(()=>generate()&&container.textContent.includes(scenario==="sign-in"?"请先登录":scenario==="read-failed"?"服务端预测读取失败":"今日尚无合格"));
   if(scenario==="generation-failed"){
    assert.equal(generate().disabled,false);
    await act(async()=>generate().click());
    await flush(()=>container.textContent.includes("新预测未完成"));
    assert.match(container.textContent,/没有服务端不可变版本，不会用浏览器基线代替/);
    assert.equal(container.querySelectorAll(".daily-prediction-card").length,0);
    assert.equal(requests.filter(row=>row.path==="/api/predictions"&&row.method==="POST").length,1);
   }else{
    assert.equal(generate().disabled,true);
    assert.equal(requests.filter(row=>row.path==="/api/predictions").length,0);
   }
  }finally{await act(async()=>root.unmount());restore()}
 }
});

test("archived recommendations default to formal snapshots, retain both slot cash rows, and support DOM controls",async()=>{
 const ui=await mountRecommendationArchive({savedTrial:true,independentPage:true});
 const {container,fixture,dom}=ui;
 try{
  assert.equal(ui.select().value,fixture.early.snapshotId,"A newer saved research trial must not replace the default formal snapshot");
  assert.match(container.querySelector(".daily-purchase-panel header h3").textContent,/每日固定组合票/);
  assert.match(container.querySelector(".purchase-summary").textContent,/整票模型概率.*总投入.*-¥2\.00.*跨场独立假设/);
  assert.match(container.querySelector(".purchase-coverage").textContent,/单场覆盖率 70\.0%/);
  assert.equal([...ui.select().options].some(option=>option.value===fixture.loadedTrial.snapshotId),true,"Saved research remains explicitly selectable");
  assert.match(ui.cash("模拟投入"),/-¥2\.00/);assert.match(ui.cash("模拟返还"),/\+¥18\.00/);assert.match(ui.cash("模拟净收益"),/\+¥16\.00/);
  assert.match(container.querySelector(".purchase-plan-module-score .purchase-risk").textContent,/旧版本未达目标门槛/);
  assert.doesNotMatch(container.querySelector(".purchase-plan-module-score .purchase-risk").textContent,/达到目标门槛/,
    "A frozen targetMet=true cannot claim a 20-yuan target when the displayed minimum profit is 16 yuan");
  const module=container.querySelector(".purchase-plan-module-score"),toggle=module.querySelector(".purchase-module-toggle");
  const controlled=()=>container.querySelector("#"+toggle.getAttribute("aria-controls"));
  assert.equal(toggle.getAttribute("aria-expanded"),"true");assert.equal(controlled().hidden,false);
  await act(async()=>toggle.click());
  assert.equal(toggle.getAttribute("aria-expanded"),"false");assert.equal(controlled().hidden,true);
  await act(async()=>ui.button("全部展开").click());
  assert.equal(toggle.getAttribute("aria-expanded"),"true");assert.equal(controlled().hidden,false);
  await act(async()=>ui.button("全部收起").click());
  assert.equal(controlled().hidden,true);
  const historyDetails=container.querySelector('details[aria-label="各投注方式历史汇总"]');
  assert.equal(historyDetails.open,false);
  await act(async()=>historyDetails.querySelector("summary").click());
  assert.equal(historyDetails.open,true,"Native history disclosure responds to the actual summary click");
  await act(async()=>historyDetails.querySelector("summary").click());
  assert.equal(historyDetails.open,false);
  const original=container.querySelector("#purchase-view-original"),doubling=container.querySelector("#purchase-view-doubling");
  await act(async()=>doubling.click());
  assert.equal(original.getAttribute("aria-selected"),"false");assert.equal(doubling.getAttribute("aria-selected"),"true");
  assert.equal(container.querySelector("#purchase-panel-original").hidden,true);assert.equal(container.querySelector("#purchase-panel-doubling").hidden,false);
  await act(async()=>doubling.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"Home",bubbles:true})));
  assert.equal(original.getAttribute("aria-selected"),"true");assert.equal(dom.window.document.activeElement,original);
  await act(async()=>original.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:"End",bubbles:true})));
  assert.equal(doubling.getAttribute("aria-selected"),"true");assert.equal(dom.window.document.activeElement,doubling);
  const slotTab=slot=>container.querySelector('[aria-label="选择固定组合票批次"] button:nth-child('+(slot==="1700"?1:2)+')');
  await act(async()=>slotTab("2100").click());
  await ui.flush(()=>ui.select()?.value===fixture.late.snapshotId&&!ui.select().disabled,"21:00 formal snapshot selection");
  assert.equal(slotTab("2100").getAttribute("aria-selected"),"true");
  assert.match(ui.cash("模拟投入"),/-¥2\.00/);assert.match(ui.cash("模拟返还"),/\+¥18\.00/);assert.match(ui.cash("模拟净收益"),/\+¥16\.00/);
  assert.match(container.querySelector("#purchase-panel-doubling").textContent,/\+¥18\.00/,"21:00 doubling retains that real purchase");
  const comparison=[...container.querySelectorAll("details")].find(node=>node.querySelector("summary strong")?.textContent==="17点 / 21点批次对照");
  const comparisonRow=[...comparison.querySelectorAll("tbody tr")].find(row=>row.cells[0].textContent===fixture.date);
  assert.ok(comparisonRow,"Both actual slots remain in the comparison");
  assert.match(comparisonRow.cells[2].textContent,/\+¥16\.00/);assert.match(comparisonRow.cells[4].textContent,/\+¥16\.00/);
  const engine=await import(await componentUrl(new URL("../app/purchase-plan-engine.js",import.meta.url)));
  const settled=[fixture.early,fixture.late].map(set=>({...set,plans:set.plans.map(plan=>engine.settlePurchasePlan(plan,fixture.results))}));
  const history=engine.summarizePurchasePlanDefinitions(settled)["score-single-2"];
  assert.equal(history.rows.length,2);assert.equal(history.stake,4);assert.equal(history.returned,36);assert.equal(history.net,32,"Shared fixtures must not erase a distinct 17/21 purchase");
  assert.equal(history.samples.uniqueFixtureCount,2);assert.equal(history.samples.ticketCount,2);
  await act(async()=>slotTab("1700").click());
  await ui.flush(()=>ui.select()?.value===fixture.early.snapshotId&&!ui.select().disabled);
  await ui.choose(fixture.loadedTrial.snapshotId);
  assert.match(container.querySelector(".daily-purchase-panel header h3").textContent,/研究试算（非正式票）/);
  assert.match(container.querySelector(".daily-purchase-panel").textContent,/历史统计与倍投计算只使用正式快照/);
  assert.match(ui.cash("模拟投入"),/-¥2\.00/);assert.match(ui.cash("模拟返还"),/\+¥18\.00/);
  await act(async()=>ui.button("刷新快照").click());
  await ui.flush(()=>ui.select()?.value===fixture.early.snapshotId&&!ui.select().disabled,"Refresh returns to the formal snapshot");
  assert.equal(JSON.stringify(ui.archive),ui.archiveBefore,"Research/slot navigation leaves original archive fixtures intact");
  assert.equal(ui.requests.some(request=>request.method!=="GET"),false,"Archive navigation makes no external writes");
  assert.deepEqual(ui.recordAccess,[]);
 }finally{await ui.dispose()}
});

test("saving a research trial through React DOM preserves formal cash and does not change the default after refresh",async()=>{
 const ui=await mountRecommendationArchive({livePrediction:true,independentPage:true});
 try{
  await ui.flush(()=>ui.button("按当前盘口试算")&&!ui.button("按当前盘口试算").disabled,"Current prediction enables trial preview");
  await act(async()=>ui.button("按当前盘口试算").click());
  await ui.flush(()=>ui.button("保存本次试算")&&!ui.button("保存本次试算").disabled,"Valid current-odds research trial is ready");
  assert.match(ui.select().value,/^manual-trial-/);
  assert.match(ui.container.querySelector(".daily-purchase-panel header h3").textContent,/研究试算（非正式票）/);
  const before={stake:ui.cash("模拟投入"),returned:ui.cash("模拟返还"),net:ui.cash("模拟净收益")};
  await act(async()=>ui.button("保存本次试算").click());
  await ui.flush(()=>ui.savedBodies.length===1&&[...ui.container.querySelectorAll('[role="status"]')].some(node=>node.textContent.includes("已保存")),"Research trial POST confirmation");
  const saved=ui.savedBodies[0];
  assert.match(saved.snapshotId,/^manual-trial-/);assert.equal(saved.scheduledTime,"17:00");
  assert.equal([...ui.select().options].some(option=>option.value===saved.snapshotId),true);
  assert.equal(ui.cash("模拟投入"),before.stake);assert.equal(ui.cash("模拟返还"),before.returned);assert.equal(ui.cash("模拟净收益"),before.net,"Saving research cannot add formal cash");
  assert.match(ui.container.textContent,/不计入17:00正式票统计/);
  await act(async()=>ui.button("刷新快照").click());
  await ui.flush(()=>ui.select()?.value===ui.fixture.early.snapshotId&&!ui.select().disabled,"Newly saved trial cannot become the refreshed default");
  assert.equal([...ui.select().options].some(option=>option.value===saved.snapshotId),true,"Refresh keeps saved research explicitly available");
  assert.match(ui.container.querySelector(".daily-purchase-panel header h3").textContent,/每日固定组合票/);
  assert.equal(JSON.stringify(ui.archive),ui.archiveBefore);
  assert.deepEqual(ui.requests.filter(request=>request.method!=="GET").map(request=>request.path),["/api/purchase-trials"],"Only the isolated research-trial fixture is saved");
 }finally{await ui.dispose()}
});
