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

test("today recommendations refresh official SP on generation, show net ranges and preserve prior results on fetch failure",async()=>{
 const Recommendations=await load("../app/components/TodayRecommendations.tsx");
 const {dom,restore}=installDom(),errors=[],container=dom.window.document.getElementById("test-root");
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
 const now=new Date().toISOString(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai"}).format(new Date()),kickoff=new Date(Date.now()+4*3600000).toISOString().replace(/\.\d{3}Z$/,"Z");
 const scores=Array.from({length:169},(_,index)=>{const score=`${Math.floor(index/13)}:${index%13}`;return {score,probability:score==="1:0"?40:score==="0:0"?30:30/167};});
 assert.equal(scores.length,169);assert.ok(Math.abs(scores.reduce((sum,point)=>sum+point.probability,0)-100)<1e-8);
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

async function mountRecommendationArchive({savedTrial=false,livePrediction=false}={}) {
 const Recommendations=await load("../app/components/TodayRecommendations.tsx");
 const {dom,restore}=installDom(),errors=[],container=dom.window.document.getElementById("test-root");
 Object.defineProperty(dom.window,"indexedDB",{value:new IDBFactory()});
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
 }catch(error){await act(async()=>root.unmount());restore();throw error}
 const select=()=>container.querySelector('select[aria-label="选择预购买方案快照"]');
 const button=text=>[...container.querySelectorAll(".daily-purchase-panel button")].find(node=>node.textContent===text);
 const choose=async id=>{await act(async()=>{select().value=id;select().dispatchEvent(new dom.window.Event("change",{bubbles:true}))});await flush(()=>select()?.value===id&&!select().disabled);};
 const cash=label=>[...container.querySelectorAll(".purchase-kanban>div")].find(node=>node.querySelector("span").textContent===label)?.textContent;
 return {dom,container,fixture,select,button,choose,cash,flush,savedBodies,requests,archive,archiveBefore,
  async dispose(){await act(async()=>root.unmount());restore();assert.deepEqual(errors.map(error=>error.message),[]);}
 };
}

test("archived recommendations default to formal snapshots, retain both slot cash rows, and support DOM controls",async()=>{
 const ui=await mountRecommendationArchive({savedTrial:true});
 const {container,fixture,dom}=ui;
 try{
  assert.equal(ui.select().value,fixture.early.snapshotId,"A newer saved research trial must not replace the default formal snapshot");
  assert.match(container.querySelector(".daily-purchase-panel header h3").textContent,/每日固定组合票/);
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
 }finally{await ui.dispose()}
});

test("saving a research trial through React DOM preserves formal cash and does not change the default after refresh",async()=>{
 const ui=await mountRecommendationArchive({livePrediction:true});
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
