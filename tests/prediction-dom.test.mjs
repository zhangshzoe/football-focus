import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import ts from "typescript";
import {JSDOM} from "jsdom";
import {IDBFactory} from "fake-indexeddb";
import {act,createElement as h} from "react";
import {renderToString} from "react-dom/server";
import {createRoot,hydrateRoot} from "react-dom/client";

const moduleUrls=new Map();
test("institution totals merge current lines, emphasize majority and retain movements",async()=>{
 const Totals=await load("../app/components/InstitutionTotalLines.tsx");
 const company=(id,total,firstTotal=total)=>({companyId:id,company:`机构${id}`,total,firstTotal});
 const render=companies=>new JSDOM(renderToString(h(Totals,{companies}))).window.document;
 let doc=render([company(2,2.5),company(3,2.5),company(22,2.5)]);
 assert.equal(doc.querySelectorAll(".institution-total-group").length,1);
 assert.match(doc.body.textContent,/2.5 球 · 3家/);
 doc=render([company(2,2.5,2),company(3,2.5),company(22,3,3.5)]);
 assert.equal(doc.querySelectorAll(".institution-total-group").length,2);
 assert.equal(doc.querySelector("strong").textContent,"2.5 球 · 2家");
 assert.equal(doc.querySelectorAll(".total-line-changed").length,2);
 assert.match(doc.body.textContent,/2 → 2.5 ↑ 升盘/);
 assert.match(doc.body.textContent,/3.5 → 3 ↓ 降盘/);
 doc=render([company(2,2),company(3,2.5),company(22,3)]);
 assert.equal(doc.querySelectorAll(".institution-total-group").length,3);
 assert.equal(doc.querySelector("strong"),null);
 doc=render([company(2,2.5,null),company(2,2.5),company(3,NaN)]);
 assert.match(doc.body.textContent,/1家/);assert.match(doc.body.textContent,/初盘未知/);
 assert.match(render([]).body.textContent,/暂无机构数据/);
});
const dataUrl=source=>`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
async function componentUrl(file){
 if(moduleUrls.has(file.href))return moduleUrls.get(file.href);
 const pending=(async()=>{
  let source=await readFile(file,"utf8");
  source=source.replace(/^import ["'][^"']+\.css["'];?\s*$/gm,"");
  let output=ts.transpileModule(source,{fileName:file.pathname,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const imports=[...output.matchAll(/\bfrom\s+(["'])([^"']+)\1/g)];
  for(const [,quote,specifier] of imports){
   let resolved;
   if(specifier.startsWith(".")){
    const base=new URL(specifier,file);
    let dependency;
    for(const suffix of /\.(?:[cm]?js|tsx?)$/.test(base.pathname)?[""]:[".tsx",".ts",".js"]){
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

test("manual fixture confirmation saves only after consent and triggers retry; storage failure does not retry",async()=>{
 const Coverage=await load("../app/components/PredictionCoverage.tsx"),{dom,restore}=installDom();
 let root,retries=0,alerts=0,confirmedId;
 try{
  root=createRoot(document.getElementById("test-root"));
  const candidate={displayId:"周五003",externalId:"isolated-ext",league:"德乙",externalTime:"2026-10-10 00:30:00",home:"海登海姆",away:"凯泽斯劳滕",canConfirmNameMatch:true};
  const match={id:"周五003",officialMatchId:"isolated-official",salesDate:"2026-10-09",kickoffAt:"2026-10-10T00:30:00+08:00",home:"海登海姆",away:"凯泽",league:"德乙",reason:"主客队名称尚未匹配",externalCandidates:[candidate]};
  await act(async()=>root.render(h(Coverage,{coverage:{officialMatches:12,predictedMatches:11,unavailableMatches:1},predictedCount:11,unavailableMatches:[match],onRetry:id=>{confirmedId=id;retries++}})));
  const button=[...document.querySelectorAll("button")].find(node=>node.textContent.includes("确认同场并执行AI预测"));
  assert.ok(button);
  dom.window.confirm=()=>false;
  await act(async()=>button.click());
  assert.equal(localStorage.getItem("ff-manual-fixture-mappings"),null);assert.equal(retries,0);
  dom.window.confirm=text=>{assert.match(text,/海登海姆 VS 凯泽斯劳滕/);return true;};
  await act(async()=>button.click());
  const saved=JSON.parse(localStorage.getItem("ff-manual-fixture-mappings"));
  assert.equal(saved[0].officialMatchId,"isolated-official");assert.equal(saved[0].externalId,"isolated-ext");assert.equal(retries,1);
  assert.equal(confirmedId,"isolated-official");
  dom.window.alert=()=>alerts++;
  dom.window.Storage.prototype.setItem=()=>{throw new Error("quota");};
  await act(async()=>button.click());
  assert.equal(alerts,1);assert.equal(retries,1);
  await act(async()=>root.render(h(Coverage,{coverage:{officialMatches:1,predictedMatches:0,unavailableMatches:1},predictedCount:0,unavailableMatches:[{...match,externalCandidates:[]}],onRetry:id=>{confirmedId=id;retries++}})));
  await act(async()=>document.querySelector(".prediction-confirm-match").click());
  assert.equal(alerts,2);assert.equal(retries,2);assert.equal(confirmedId,undefined,"Missing candidates trigger a fresh fetch, never a confirmed-match override");
  assert.equal(localStorage.getItem("ff-manual-fixture-mappings"),JSON.stringify(saved));
 }finally{if(root)await act(async()=>root.unmount());restore();}
});

test("confirmation refreshes a qualified version then invokes AI with that version, not stale state",async()=>{
 const Home=await load("../app/page.tsx"),{dom,restore}=installDom();
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
 const now=new Date().toISOString(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date());
 const version={predictionId:"confirmed-base",inputSnapshotId:"isolated-input",baseModelVersion:"test",calibrationVersion:"none",generatedAt:now};
 const row={...fixture("周五003"),...version,officialMappingStatus:"verified",salesDate:date,matchDate:date};
 const candidate={displayId:row.id,externalId:"isolated-ext",league:row.league,externalTime:row.time,home:row.home,away:"另一译名",canConfirmNameMatch:true};
 const match={...row,matchId:row.officialMatchId,odds:[2,3.2,3.8],marketOdds:{"胜平负":[2,3.2,3.8]},form:[],risk:"",tag:"",matchStatus:"Selling"};
 let aiCalls=0;const requests=[];
 globalThis.fetch=async(url,options={})=>{
  const path=String(url);requests.push(path);
  if(path.startsWith("/api/sporttery"))return Response.json({matches:[match],fetchedAt:now});
  if(path==="/api/predictions"){
   const body=JSON.parse(options.body),confirmed=body.manualMappings?.some(record=>record.officialMatchId===row.officialMatchId);
   return Response.json({reports:confirmed?[row]:[],...version,version,fetchedAt:now,unavailableOfficialMatches:confirmed?[]:[{...match,reason:"主客队名称尚未匹配",externalCandidates:[candidate]}]});
  }
  if(path.startsWith("/api/predictions/ai")){
   const body=JSON.parse(options.body);aiCalls++;
   assert.equal(body.version.predictionId,"confirmed-base");assert.equal(body.reports[0].officialMatchId,row.officialMatchId);
   return Response.json({version:{...version,predictionId:"confirmed-ai",reviewForPredictionId:"confirmed-base"},reports:[{...row,predictionId:"confirmed-ai",aiSummary:"隔离测试复核"}]});
  }
  if(path.startsWith("/api/prediction-snapshots"))return Response.json({snapshots:[]});
  if(path==="/api/model-audit")return Response.json({});
  throw new Error("Unexpected isolated request: "+path);
 };
 const root=createRoot(document.getElementById("test-root"));
 try{
  await act(async()=>{root.render(h(Home));await new Promise(resolve=>setTimeout(resolve,30))});
  const findButton=()=>[...document.querySelectorAll("button")].find(button=>button.textContent==="确认同场并执行AI预测");
  for(let i=0;i<50&&!findButton();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});
  assert.ok(findButton());assert.equal(aiCalls,0);
  dom.window.confirm=()=>true;
  await act(async()=>{findButton().click();await new Promise(resolve=>setTimeout(resolve,30))});
  for(let i=0;i<50&&!aiCalls;i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20))});
  assert.equal(aiCalls,1);
  assert.match(document.querySelector(".compact-predictions-page").textContent,/隔离测试复核/);
  assert.equal(document.querySelector(".recommendations-page"),null);
  assert.deepEqual(requests.filter(path=>path.startsWith("/api/purchase-trials")||path.includes("view=recommendations")),[],"AI route must not mount recommendation data loaders in the background");
 }finally{await act(async()=>root.unmount());restore();}
});

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
 const [Home,Notice]=await Promise.all([load("../app/page.tsx"),load("../app/components/BrowserStorageNotice.tsx")]);
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
  if(path==="/api/predictions")return Response.json({reports:rows,...version,version,fetchedAt:now,unavailableOfficialMatches:[]});
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
  assert.match(dom.window.document.querySelector(".browser-storage-notice").textContent,/投注记录暂未保存/);
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
const commonProps={loading:false,error:"",aiError:"",fetchedAt:"",sourceUrl:"",methodology:"测试模型",aiProvider:"",aiLoading:false,onAiReview(){}};

test("page load status renders Beijing time, loading and unavailable states",async()=>{
 const Status=await load("../app/components/PageLoadStatus.tsx");
 const render=props=>new JSDOM(renderToString(h(Status,props))).window.document;
 const loadedAt="2026-10-16T08:59:00.000Z",doc=render({loadedAt});
 assert.equal(doc.querySelector("time").dateTime,loadedAt);
 assert.match(doc.querySelector("time").textContent,/16:59:00/);
 assert.match(doc.body.textContent,/本次加载：.*（北京时间）/);
 assert.match(doc.body.textContent,/页面停留期间不自动更新/);
 const loading=render({loadedAt,loading:true});
 assert.match(loading.body.textContent,/正在加载数据/);
 assert.equal(loading.querySelector("time").dateTime,loadedAt,"Loading retains the last successful load time");
 for(const loadedAt of ["","invalid"]){
  const unavailable=render({loadedAt});
  assert.equal(unavailable.querySelector("time"),null);
  assert.match(unavailable.body.textContent,/尚未成功加载/);
 }
});

test("recommendations stay unchanged across time and visibility, with explicit snapshot refresh preserving the last success on failure",async context=>{
 const Recommendations=await load("../app/components/TodayRecommendations.tsx"),{dom,restore}=installDom();
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
 const requests=[],date="2026-10-16",version="manual-refresh-test";
 const matches=[{...fixture("周五001"),predictionId:version,salesDate:date,matchDate:date,kickoffAt:"2026-10-16T23:00:00+08:00"}];
 let fail=false;
 globalThis.fetch=async url=>{
  const path=String(url);requests.push(path);
  if(path.startsWith("/api/prediction-snapshots"))return fail?Response.json({error:"temporary failure"},{status:502}):Response.json({snapshots:[]});
  if(path==="/api/purchase-trials")return Response.json({trials:[]});
  if(path==="/api/sporttery")return Response.json({matches:[],fetchedAt:new Date().toISOString()});
  if(path.startsWith("/api/sporttery/results"))return Response.json({results:[]});
  throw new Error(`Unexpected manual refresh request: ${path}`);
 };
 const root=createRoot(document.getElementById("test-root"));
 const settle=async()=>{for(let i=0;i<30;i++)await act(async()=>{context.mock.timers.tick(0);await new Promise(resolve=>setImmediate(resolve))})};
 const refresh=()=>[...document.querySelectorAll("button")].find(button=>button.textContent==="刷新快照");
 const loadedTime=()=>document.querySelector(".page-load-status time")?.dateTime;
 try{
  const storage=await import(await componentUrl(new URL("../app/browser-storage.ts",import.meta.url)));
  await storage.writeBrowserData("ff-today-predictions-v3",{date,predictionId:version,matches});
  context.mock.timers.enable({apis:["Date","setTimeout","setInterval"],now:Date.parse("2026-10-16T08:59:00Z")});
  await act(async()=>root.render(h(Recommendations)));
  await settle();
  assert.ok(refresh());assert.equal(refresh().disabled,false);assert.ok(loadedTime());
  assert.ok(requests.includes("/api/sporttery"),"Saved predictions must load official markets on entry");
  const initialTime=loadedTime(),initialRequests=[...requests];
  await act(async()=>{
   context.mock.timers.tick(2*3600000);
   Object.defineProperty(document,"visibilityState",{value:"visible",configurable:true});
   document.dispatchEvent(new dom.window.Event("visibilitychange"));
  });
  await settle();
  assert.deepEqual(requests,initialRequests,"Staying open past 17:05 and becoming visible must not fetch new data");
  assert.equal(loadedTime(),initialTime);
  await act(async()=>refresh().click());await settle();
  assert.equal(requests.filter(path=>path.startsWith("/api/prediction-snapshots")).length,initialRequests.filter(path=>path.startsWith("/api/prediction-snapshots")).length+1);
  const refreshedTime=loadedTime();assert.notEqual(refreshedTime,initialTime);
  fail=true;context.mock.timers.tick(60000);
  await act(async()=>refresh().click());await settle();
  assert.equal(loadedTime(),refreshedTime,"Failed refresh must preserve the last successful timestamp");
 }finally{await act(async()=>root.unmount());context.mock.timers.reset();restore()}
});

test("market half-full tab shows exactly two ranked outcomes and does not fabricate missing probabilities",async()=>{
 const Table=await load("../app/components/MarketPredictionTable.tsx"),{dom,restore}=installDom();let root;
 try{
  root=createRoot(document.getElementById("test-root"));
  const valid=fixture("001"),missing=fixture("002"),invalid=fixture("003");
  delete missing.marketSignal.modeledHalfFull;invalid.marketSignal.modeledHalfFull=[NaN,10,5,10,20,5,5,5,10];
  await act(async()=>root.render(h(Table,{...commonProps,rows:[valid,missing,invalid]})));
  for(const label of ["胜平负和让球","比分","大小球","半全场"]){
   const button=[...document.querySelectorAll(".forecast-view-tabs button")].find(node=>node.textContent===label);assert.ok(button);
   await act(async()=>button.click());
   const summary=document.querySelector(".half-full-summary");
   assert.equal(document.querySelectorAll("td.institution-total").length,3);
   assert.ok(document.querySelector("thead").textContent.includes("机构大小球"));
   assert.deepEqual([...summary.querySelectorAll(".half-full-summary-pick")].map(node=>node.textContent),["胜胜30.0%","平平20.0%"]);
   assert.equal(document.querySelector(".forecast-expectation"),null);
   assert.ok(!document.querySelector("thead").textContent.includes("外围盘口预测"));
   for(const row of [...document.querySelectorAll("tbody tr")].slice(1))assert.equal(row.querySelector(".half-full-summary").textContent,"暂无数据");
  }
  const tab=[...document.querySelectorAll("button")].find(node=>node.textContent==="半全场");assert.ok(tab);
  await act(async()=>tab.dispatchEvent(new dom.window.MouseEvent("click",{bubbles:true})));
  const rows=[...document.querySelectorAll(".forecast-view-halfFull tbody tr")];assert.equal(rows.length,3);
  const picks=row=>[...row.querySelectorAll('td[data-label^="半全场"]')].map(cell=>cell.textContent);
  assert.deepEqual(picks(rows[0]),["胜胜","30.0%","平平","20.0%"]);
  for(const row of rows.slice(1))assert.deepEqual(picks(row),["暂无数据","—","暂无数据","—"]);
  await act(async()=>root.unmount());
 }finally{restore()}
});

test("today recommendations refresh official SP on generation, show net ranges and preserve prior results on fetch failure",async()=>{
 const Recommendations=await load("../app/components/TodayRecommendations.tsx");
 const {dom,restore}=installDom(),errors=[],container=dom.window.document.getElementById("test-root");
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
 const now=new Date().toISOString(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date()),kickoff=new Date(Date.now()+4*3600000).toISOString().replace(/\.\d{3}Z$/,"Z");
 const scores=[{score:"1:0",probability:40},{score:"0:0",probability:30}];
 const matches=[1,2].map(i=>({id:`周一00${i}`,officialMatchId:`returns-${i}`,predictionId:"returns-version",salesDate:date,matchDate:date,kickoffAt:kickoff,time:kickoff,home:`主队${i}`,away:`客队${i}`,league:"测试联赛",officialMappingStatus:"verified",sourceFetchedAt:now,confidence:85,completeness:10,singleModel:false,combinedScores:scores,fullScoreDistribution:scores}));
 dom.window.localStorage.setItem("ff-today-predictions-v3",JSON.stringify({date,predictionId:"returns-version",matches}));
 let calls=0,fail=false,missing=false;
 globalThis.fetch=async url=>{
  const path=String(url);
  if(path==="/api/sporttery"){
   calls++;if(fail)return Response.json({error:"官方接口暂不可用"},{status:502});
   return Response.json({fetchedAt:new Date().toISOString(),matches:matches.map((match,i)=>{
    const odds=Array(31).fill(0);odds[0]=calls===1?99:i===0?2:6;odds[13]=missing&&i===0?0:calls===1?88:i===0?3:10;
    return {...match,matchStatus:"Selling",marketOdds:{"比分":odds},marketEligibility:{"比分":{marketCode:"CRS",qualification:"qualified",salesStatus:"Selling",allowedPassCounts:[1,2,3,4],cutoffAt:kickoff}}};
   })});
  }
  if(path.startsWith("/api/prediction-snapshots"))return Response.json({snapshots:[]});
  if(path.startsWith("/api/sporttery/results"))return Response.json({results:[]});
  throw new Error(`Unexpected request: ${path}`);
 };
 const root=createRoot(container,{onUncaughtError:error=>errors.push(error),onRecoverableError:error=>errors.push(error)});
 const flush=async predicate=>{for(let i=0;i<60&&!predicate();i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,15))});assert.ok(predicate(),`Expected UI state did not settle: ${container.textContent.slice(0,700)}`)};
 try{
  const storage=await import(await componentUrl(new URL("../app/browser-storage.ts",import.meta.url)));
  await storage.writeBrowserData("ff-today-predictions-v3",{date,predictionId:"returns-version",matches});
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
  assert.equal(container.querySelectorAll(".recommendation-return-panel").length,0,"Incomplete odds must not produce a recommended ticket");
  await act(async()=>container.querySelector('input[name="score-count"]').click());
  assert.equal(container.querySelectorAll(".combination-card").length,0,"Changing filters must clear old financial estimates");
  await act(async()=>container.querySelector('#purchase-view-doubling').click());
  assert.equal(container.querySelector('#purchase-panel-original').hidden,true);
  assert.equal(container.querySelector('#purchase-panel-doubling').hidden,false);
  assert.match(container.querySelector('#purchase-panel-doubling').textContent,/胜平负单选2串1与2倍 A\/B\/C分别从100元开始/);
  assert.match(container.querySelector('#purchase-panel-doubling').textContent,/其他方式独立从1倍开始/);
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
 const hundredYuanHistory=Object.fromEntries(["had-safe-2","twofold-a","twofold-b","twofold-c"].map(id=>[id,{rows:rows.slice(0,3).map(row=>({...row,plan:{...row.plan,id,stake:2,simulatedReturn:row.plan.status==="won"?6.35:0}}))}]));
 const html=renderToString(h(Summary,{history:{"total-double-2":{rows},...hundredYuanHistory},slot:"1700",loading:false}));
 const doc=new JSDOM(html).window.document;
 assert.match(doc.body.textContent,/8元 → 16元 → 24元 → 32元/);
 assert.match(doc.body.textContent,/按1、2、3、4倍依次递增/);
 for(const title of ['胜平负单选2串1','2倍 A · 单选2串1','2倍 B · 单选2串1','2倍 C · 单选2串1']) {
 const resultSummary=[...doc.querySelectorAll('.purchase-doubling-history > details')].find(node=>node.querySelector('strong').textContent.includes(title));
 assert.match(resultSummary.textContent,/100元起投 · 未中翻倍 · 中奖回到100元/);
 assert.deepEqual([...resultSummary.querySelectorAll('tbody tr')].map(row=>row.children[4].textContent),['-¥100.00','-¥200.00','-¥400.00']);
 assert.match(resultSummary.textContent,/\+¥1,270\.00/);
 }
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
  assert.equal(container.querySelector(".forecast-expectation"),null);
  assert.equal(container.querySelectorAll(".half-full-summary-pick").length,22);
  const scoreTab=[...container.querySelectorAll(".forecast-view-tabs button")].find(button=>button.textContent==="比分");
  await act(async()=>scoreTab.click());
  assert.ok(container.querySelector(".forecast-view-score"));
  const filter=container.querySelector(".market-prediction-filters select");
  await act(async()=>{filter.value="测试联赛";filter.dispatchEvent(new dom.window.Event("change",{bubbles:true}))});
  await render([fixture("周一003","客队方向 · 降盘，部分一致，偏向小球")]);
  assert.equal(container.querySelectorAll(".market-forecast-table tbody tr").length,1);
  assert.equal(container.querySelectorAll(".half-full-summary-pick").length,2);
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
