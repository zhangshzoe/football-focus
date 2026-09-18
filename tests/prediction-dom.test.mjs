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
  if(path==="/api/prediction-snapshots")return Response.json({snapshots:[]});
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
  if(path==="/api/prediction-snapshots")return Response.json({snapshots:[]});
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
  await flush(()=>!!container.querySelector(".missing-odds"));
  assert.match(container.querySelector(".recommendation-return-panel").textContent,/待补赔率/);
  assert.doesNotMatch(container.querySelector(".recommendation-return-panel").textContent,/¥52\.00/);
  await act(async()=>container.querySelector('input[name="score-count"]').click());
  assert.equal(container.querySelectorAll(".combination-card").length,0,"Changing filters must clear old financial estimates");
  await act(async()=>root.unmount());
  assert.deepEqual(errors.map(error=>error.message),[]);
 }finally{await act(async()=>root.unmount());restore()}
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
