import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {register} from "node:module";
import {calculatePurchaseLegReturns,deduplicatePurchasePlans,generatePurchasePlans,PURCHASE_PLAN_DEFINITIONS,PURCHASE_PLAN_MODULES,MARKET_META,settlePurchasePlan,summarizePurchasePlanModules,summarizePurchasePlanDefinitions,summarizePurchasePlanDays} from "../app/purchase-plan-engine.js";
import {DEFAULT_RECOMMENDATION_POLICY,assessRecommendation,canonicalTicketKey} from "../app/recommendation-policy.js";
import {calculateTicketEconomics,ticketFixtureKey} from "../app/ticket-economics.js";
async function readWorkspaceSource(){return (await Promise.all(["football-workspace.ts","hooks/useOfficialMatches.ts","hooks/usePredictionWorkspace.ts","components/MatchesWorkspace.tsx","components/PredictionWorkspace.tsx","components/OfficialSourceNotice.tsx"].map(path=>readFile(new URL("../app/"+path,import.meta.url),"utf8")))).join("\n")}
const completePoints=(labels,weights)=>{const missing=labels.filter(label=>!Object.hasOwn(weights,label)),remaining=100-Object.values(weights).reduce((sum,p)=>sum+p,0);assert.ok(remaining>=-1e-8);return labels.map(score=>({score,probability:Object.hasOwn(weights,score)?weights[score]:missing.length?remaining/missing.length:0}));};
const scoreGridFixture=weights=>completePoints(Array.from({length:169},(_,index)=>`${Math.floor(index/13)}:${index%13}`),weights);

test("daily snapshot summary excludes missing dates and unsettled tickets from returns",()=>{
 const days=summarizePurchasePlanDays([
  {snapshotId:"summary-early",date:"2026-09-25",generatedAt:"2026-09-25T17:00:00+08:00",plans:[{status:"won",stake:2,simulatedReturn:20,items:[{}]},{status:"awaiting_result",stake:2,items:[{}]}]},
  {snapshotId:"summary-late",date:"2026-09-25",generatedAt:"2026-09-25T21:00:00+08:00",plans:[{status:"lost",stake:4,simulatedReturn:0,items:[{}]}]},
  {snapshotId:"summary-none",date:"2026-09-26",generatedAt:"2026-09-26T17:00:00+08:00",plans:[{status:"unavailable",items:[]}]},
 ]);
 assert.deepEqual(days["2026-09-25"],{date:"2026-09-25",batches:2,tickets:3,pending:1,settled:2,refunded:0,won:1,rate:50,stake:6,returned:20,net:14});
 assert.equal(days["2026-09-26"].tickets,0);
 assert.equal(days["2026-09-27"],undefined);
});
import {teamIdentity} from "../app/team-identity.js";
import {decisionTargetAt,selectOfficialDecisionRows,selectDecisionObservations} from "../app/snapshot-decision-policy.js";
import {snapshotIdFromFileName} from "../app/snapshot-file-policy.js";
import {buildArchiveRecoverySnapshots} from "../app/archive-recovery.js";

test("official snapshot timing follows weekday and weekend decision rules",()=>{
 assert.equal(decisionTargetAt("2026-09-14","2026-09-14T21:00:00+08:00"),"2026-09-14T12:30:00.000Z");
 assert.equal(decisionTargetAt("2026-09-14","2026-09-14T22:00:00+08:00"),"2026-09-14T13:30:00.000Z");
 assert.equal(decisionTargetAt("2026-09-13","2026-09-13T22:50:00+08:00"),"2026-09-13T14:20:00.000Z");
 assert.equal(decisionTargetAt("2026-09-13","2026-09-13T23:00:00+08:00"),"2026-09-13T14:30:00.000Z");
 const match={id:"周一001",officialMatchId:"m1",salesDate:"2026-09-14",kickoffAt:"2026-09-14T22:30:00+08:00",home:"甲",away:"乙"};
 const rows=selectOfficialDecisionRows([{snapshotId:"early",date:"2026-09-14",capturedAt:"2026-09-14T13:20:00.000Z",matches:[match]},{snapshotId:"chosen",date:"2026-09-14",capturedAt:"2026-09-14T13:30:00.000Z",matches:[match]},{snapshotId:"late",date:"2026-09-14",capturedAt:"2026-09-14T13:31:00.000Z",matches:[match]}]);
 assert.equal(rows.length,1);assert.equal(rows[0].snapshot.snapshotId,"chosen");
 const delayedScheduled=selectOfficialDecisionRows([{snapshotId:"scheduled",date:"2026-09-14",scheduledAt:"2026-09-14T21:30:00+08:00",capturedAt:"2026-09-14T13:32:00.000Z",matches:[match]}]);
 assert.equal(delayedScheduled.length,0);
});

test("legacy and immutable raw snapshot filenames share the same online index identity",()=>{
 assert.equal(snapshotIdFromFileName("2026-09-07_2000.json"),"2026-09-07-2000");
 assert.equal(snapshotIdFromFileName("2026-09-22_2130.raw.json"),"2026-09-22-2130");
 assert.equal(snapshotIdFromFileName("2026-09-22_2130.supplement.ai.json"),"");
});

const cloudReadTypes=[];
const workerEnv={
 ASSETS:{fetch:async()=>new Response("Not found",{status:404})},
 DB:{prepare(sql){
  if(sql==="SELECT id FROM research_capture_records WHERE record_type = ? ORDER BY observed_at DESC, id DESC LIMIT 1")return {bind(type){assert.ok(["replay-index","source-attempt"].includes(type));return {async first(){return null;}};}};
  assert.match(sql,/^SELECT id, observed_at FROM research_capture_records /);
  return {
   bind(type){
    assert.ok(["raw","purchase","source-attempt","replay-index"].includes(type));
    return {async all(){cloudReadTypes.push(type);return {results:[]};}};
   },
  };
 }},
 RESEARCH_OBJECTS:{async get(){return null;},async put(){throw new Error("Read-only recovery must not write");}},
};
globalThis.__footballRenderedWorkerEnv=workerEnv;
const moduleUrl=source=>`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const cloudEnvUrl=moduleUrl("export const env=globalThis.__footballRenderedWorkerEnv;");
register(moduleUrl(`export async function resolve(specifier,context,nextResolve){
 if(specifier==="cloudflare:workers")return {url:${JSON.stringify(cloudEnvUrl)},shortCircuit:true};
 return nextResolve(specifier,context);
}`),import.meta.url);

async function render(path="/"){
 const workerUrl=new URL("../dist/server/index.js",import.meta.url);
 workerUrl.searchParams.set("test",`${process.pid}-${Date.now()}-${path}`);
 const {default:worker}=await import(workerUrl.href);
 return worker.fetch(new Request(`http://localhost${path}`,{headers:{accept:"text/html"}}),workerEnv,{waitUntil(){},passThroughOnException(){}});
}

test("production total-goals API serves precomputed diagnostic summary without raw replay inputs",async()=>{
 const response=await render("/api/total-goals-validation"),data=await response.json();
 assert.equal(response.status,200);
 assert.equal(data.report.schemaVersion,1);
 assert.equal(data.report.promotionEligible,false);
 assert.ok(Array.isArray(data.report.cohorts));
 assert.ok(Array.isArray(data.report.tickets.rows));
 assert.equal(data.storageOrigin,"bundled-offline-index");
 assert.equal(data.indexReadStatus,"cloud-report-missing");
 assert.equal(Object.hasOwn(data,"observations"),false);
 assert.equal(Object.hasOwn(data,"purchases"),false);
 assert.match(response.headers.get("cache-control"),/no-store/);
});

test("total-goals API marks missing cloud reports and rejects corrupt or retired pipeline summaries",async()=>{
 const index=JSON.parse(await readFile(new URL("../data/generated-total-goals-validation-index.json",import.meta.url),"utf8"));
 const routeSource=await readFile(new URL("../app/api/total-goals-validation/route.ts",import.meta.url),"utf8");
 const previous=process.env.NODE_ENV;process.env.NODE_ENV="production";
 try{
  for(const scenario of ["missing","corrupt","retired","valid","cloud-valid-bundle-retired"]){
   const cloudReport=structuredClone(index.report);
   if(scenario==="retired")cloudReport.pipelineVersion="retired-pipeline";
   const payload=scenario==="missing"?{}:{totalGoalsValidation:scenario==="corrupt"?{schemaVersion:1,cohorts:[],tickets:{rows:[]}}:cloudReport};
   const storeUrl=moduleUrl(`export function getCloudResearchStore(){return {async latest(type){return {payload:type==="replay-index"?${JSON.stringify(payload)}:{status:"failed"}}}}}`);
   const bundledReport=structuredClone(index.report);if(scenario==="cloud-valid-bundle-retired")bundledReport.pipelineVersion="retired-pipeline";
   const source=routeSource.replace('import { NextResponse } from "next/server";','const NextResponse={json:(body,init={})=>new Response(JSON.stringify(body),{...init,headers:{"Content-Type":"application/json",...(init.headers||{})}})};')
    .replace('import index from "../../../data/generated-total-goals-validation-index.json";',`const index=${JSON.stringify({report:bundledReport})};`)
    .replace('from "../../cloud-research-binding"',`from ${JSON.stringify(storeUrl)}`)
    .replace('from "../../total-goals-validation-contract.js"',`from ${JSON.stringify(new URL("../app/total-goals-validation-contract.js",import.meta.url).href)}`)
    .replace('from "../../prediction-model.js"',`from ${JSON.stringify(new URL("../app/prediction-model.js",import.meta.url).href)}`);
   const {GET}=await import(moduleUrl(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText)+`#${scenario}`);
   const response=await GET(),body=await response.json();
   assert.deepEqual(body.report,index.report);
   if(scenario==="valid"||scenario==="cloud-valid-bundle-retired"){assert.equal(response.status,200);assert.equal(body.storageOrigin,"cloud-background-index");}
   else if(scenario==="missing"){assert.equal(response.status,200);assert.equal(body.indexReadStatus,"cloud-report-missing");}
   else{assert.equal(response.status,503);assert.equal(body.storageOrigin,"bundled-offline-index");assert.equal(body.indexReadStatus,"cloud-unavailable");}
  }
 }finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
});

test("official outage research stays separate from purchasable and archived forecasts",async()=>{
 const [route,page,report,review]=await Promise.all([
  readFile(new URL("../app/api/predictions/route.ts",import.meta.url),"utf8"),
  readWorkspaceSource(),
  readFile(new URL("../app/components/AiPredictionReport.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/api/predictions/ai/route.ts",import.meta.url),"utf8")
 ]);
 assert.match(route,/mode:\s*"research-only"/);
 assert.match(route,/officialMappingStatus:\s*"unmatched",\s*marketEligibility:\s*\{\}/);
 assert.match(route,/officialOdds:\s*\[\],\s*officialHandicap:\s*"",\s*officialHhadOdds:\s*\[\]/);
 assert.match(route,/if\s*\(kickoff\s*<=\s*now\)\s*return\s*\[\]/);
 assert.match(page,/setResearchRows\(rows\)/);
 assert.match(page,/researchOnly\s+rows=\{researchRows\}/);
 assert.match(page,/matches:\s*predictionRows\.map\(/);
 assert.match(report,/不参与选号、每日固定票或正式赛前复盘/);
 assert.match(review,/外围研究不能混入官方预测版本/);
});

async function loadSportteryRoute(){
 // Each mock below is a different source incident. Circuit timing has its own
 // isolated tests; do not let one synthetic incident pause the next fixture.
 const sharedSource=(await readFile(new URL("../app/sporttery-official.ts",import.meta.url),"utf8")).replace('from "./source-recovery.js"',`from ${JSON.stringify(new URL("../app/source-recovery.js",import.meta.url).href)}`).replace('const recovery = sourceRecovery();','const recovery = {run: (_key, task) => task()};'),sharedJavascript=ts.transpileModule(sharedSource,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,sharedUrl=`data:text/javascript;base64,${Buffer.from(sharedJavascript).toString("base64")}#${Date.now()}-${Math.random()}`;
 const source=(await readFile(new URL("../app/api/sporttery/route.ts",import.meta.url),"utf8")).replace(/import\s*\{\s*NextResponse\s*\}\s*from "next\/server";/,'const NextResponse={json:(body,init={})=>new Response(JSON.stringify(body),{...init,headers:{"Content-Type":"application/json",...(init.headers||{})}})};').replace('from "../../sporttery-official"',`from "${sharedUrl}"`);
 const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 return import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}#${Date.now()}-${Math.random()}`);
}

const officialRow=(pool,zero=false)=>({matchId:"2041234",matchNumStr:"周三001",leagueAbbName:"测试联赛",matchTime:"2026-09-09 20:00:00",matchDate:"2026-09-09",homeTeamAbbName:"主队",awayTeamAbbName:"客队",matchStatus:"Selling",sellStatus:1,[pool.toLowerCase()]:pool==="HAD"?{h:zero?0:2.1,d:zero?0:3.2,a:zero?0:3.4}:pool==="HHAD"?{h:zero?0:3.1,d:zero?0:3.4,a:zero?0:1.9,goalLine:"-1"}:pool==="CRS"?{s01s00:zero?0:7.2}:pool==="TTG"?{s2:zero?0:3.2}:pool==="HAFU"?{hh:zero?0:2.8}:{}});
const poolPayload=(rows=[])=>({success:true,value:{lastUpdateTime:"2026-09-09 12:00:00",matchInfoList:rows.length?[{subMatchList:rows}]:[]}});

test("verified Chinese team aliases preserve strict match identity",()=>{
 assert.equal(teamIdentity("女王巡游"),teamIdentity("女王公园"));
 assert.equal(teamIdentity("里斯本"),teamIdentity("葡萄牙体育"));
 assert.equal(teamIdentity("加拉塔萨"),teamIdentity("加拉塔萨雷"));
 assert.equal(teamIdentity("巴黎圣曼"),teamIdentity("巴黎圣日耳曼"));
 assert.equal(teamIdentity("摩雷伦斯"),teamIdentity("莫雷拉人"));
 assert.equal(teamIdentity("莱红牛"),teamIdentity("RB莱比锡"));
 assert.equal(teamIdentity("斯拉维亚"),teamIdentity("布拉格斯拉维亚"));
 assert.equal(teamIdentity("阿马多拉"),teamIdentity("阿马多拉之星"));
 assert.equal(teamIdentity("德尔瓦耶"),teamIdentity("山谷独立"));
 assert.equal(teamIdentity("京都"),teamIdentity("京都不死鸟"));
 assert.equal(teamIdentity("哈马费萨"),teamIdentity("费萨里"));
 assert.equal(teamIdentity("阿尔克马"),teamIdentity("阿尔克马尔"));
 assert.equal(teamIdentity("马斯特里"),teamIdentity("马斯特里赫特"));
 assert.equal(teamIdentity("阿尔梅勒"),teamIdentity("阿尔梅勒城"));
 assert.equal(teamIdentity("雷克斯"),teamIdentity("雷克瑟姆"));
 assert.equal(teamIdentity("巴伦西亚"),teamIdentity("瓦伦西亚"));
 assert.equal(teamIdentity("桑坦德"),teamIdentity("桑坦德竞技"));
 assert.equal(teamIdentity("布伦特"),teamIdentity("布伦特福德"));
 assert.equal(teamIdentity("维拉"),teamIdentity("阿斯顿维拉"));
 assert.equal(teamIdentity("不来梅"),teamIdentity("云达不莱梅"));
 assert.equal(teamIdentity("大宫松鼠"),teamIdentity("RB大宫松鼠"));
 assert.equal(teamIdentity("蔚山现代"),teamIdentity("蔚山HD"));
 assert.equal(teamIdentity("尤文"),teamIdentity("尤文图斯"));
 assert.equal(teamIdentity("巴竞技"),teamIdentity("巴拉纳竞技"));
 assert.notEqual(teamIdentity("曼联"),teamIdentity("曼城"));
});

test("server renders the football research site",async()=>{
 const response=await render("/");
 assert.equal(response.status,200);
 assert.match(response.headers.get("content-type")??"",/^text\/html\b/i);
 const html=await response.text();
 assert.match(html,/<html lang="zh-CN">/i);
 assert.match(html,/<title>竞彩研习室｜个人足球研究与复盘<\/title>/i);
 assert.match(html,/今日比赛/);
 assert.match(html,/盘后回溯/);
 assert.doesNotMatch(html,/Your site is taking shape|Building your site/);
});

test("mobile shell, install metadata and preview workspace are published",async()=>{
 const [layout,manifest,preview,mobileStyles]=await Promise.all([
  readFile(new URL("../app/layout.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/manifest.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/mobile-preview/page.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/mobile-ui.css",import.meta.url),"utf8"),
 ]);
 assert.match(layout,/export const viewport:\s*Viewport/);
 assert.match(layout,/manifest:\s*"\/manifest\.webmanifest"/);
 assert.match(layout,/import "\.\/mobile-ui\.css"/);
 assert.match(manifest,/display:\s*"standalone"/);
 assert.match(preview,/手机预览/);
 assert.match(preview,/\/prediction-archive/);
 assert.match(mobileStyles,/@media\(max-width:767px\)/);
 assert.match(mobileStyles,/env\(safe-area-inset-bottom\)/);
 assert.match(mobileStyles,/archive-review-table td:before/);
 const response=await render("/mobile-preview");
 assert.equal(response.status,200);
 const html=await response.text();
 assert.match(html,/手机预览/);
 assert.match(html,/手机访问方式/);
});

test("official markets never fall back to demo odds and tolerate independent pool failures",async()=>{
 const originalFetch=globalThis.fetch,{GET}=await loadSportteryRoute();
 const get=()=>GET(new Request("http://localhost/api/sporttery"));
 try{
  globalThis.fetch=async()=>new Response(JSON.stringify(poolPayload()),{status:200});
  let response=await get(),data=await response.json();
  assert.equal(response.status,200);assert.deepEqual(data.matches,[]);

  globalThis.fetch=async url=>{const pool=new URL(String(url)).searchParams.get("poolCode");return new Response(JSON.stringify(poolPayload([officialRow(pool,pool==="HHAD")])),{status:200})};
  response=await get();data=await response.json();
  assert.equal(data.matches.length,1);assert.equal(data.matches[0].marketOdds["让球胜平负"],null);assert.equal(data.matches[0].marketStatus["让球胜平负"],"unavailable");

  globalThis.fetch=async url=>{const pool=new URL(String(url)).searchParams.get("poolCode");return new Response(JSON.stringify(poolPayload([{...officialRow(pool),matchId:2041686}])),{status:200})};
  response=await get();data=await response.json();
  assert.equal(response.status,200);assert.equal(data.matches.length,1);assert.equal(data.matches[0].officialMatchId,"2041686");

  globalThis.fetch=async url=>{const pool=new URL(String(url)).searchParams.get("poolCode");if(pool==="CRS")throw new Error("比分玩法超时");return new Response(JSON.stringify(poolPayload([officialRow(pool)])),{status:200})};
  response=await get();data=await response.json();
  assert.equal(response.status,200);assert.equal(data.matches.length,1);assert.equal(data.poolStatus.CRS.status,"failed");assert.equal(data.matches[0].marketOdds["比分"],null);assert.equal(data.matches[0].marketStatus["比分"],"failed");

  globalThis.fetch=async url=>{const pool=new URL(String(url)).searchParams.get("poolCode");const row=officialRow(pool);if(pool==="HAD")delete row.matchId;return new Response(JSON.stringify(poolPayload([row])),{status:200})};
  response=await get();data=await response.json();
  assert.equal(response.status,200);assert.equal(data.poolStatus.HAD.status,"failed");
  assert.equal(data.matches[0].marketOdds["胜平负"],null);

  globalThis.fetch=async url=>{
   const request=new URL(String(url)),pool=request.searchParams.get("poolCode");
   if(pool)return new Response("unavailable",{status:502});
   assert.equal(request.searchParams.get("channel"),"c");
   const row={...officialRow("HAD"),hhad:officialRow("HHAD").hhad,crs:officialRow("CRS").crs,ttg:officialRow("TTG").ttg,hafu:officialRow("HAFU").hafu,poolList:["HAD","HHAD","CRS","TTG","HAFU"].map(poolCode=>({poolCode,poolStatus:"Selling",bettingAllup:1,bettingSingle:1}))};
   const payload=poolPayload([row]);
   payload.value.lastUpdateTime=new Date(Date.now()+8*3600000).toISOString().slice(0,19).replace("T"," ");
   return new Response(JSON.stringify(payload),{status:200});
  };
  response=await get();data=await response.json();
  assert.equal(response.status,200);assert.equal(data.deliveryMode,"server-mobile-calculator");
  assert.equal(data.matches[0].marketOdds["胜平负"][0],2.1);
  assert.equal(data.matches[0].marketOdds["总进球数"][2],3.2);

  globalThis.fetch=async url=>new URL(String(url)).searchParams.has("poolCode")
   ?new Response("blocked",{status:567})
   :new Response(JSON.stringify(poolPayload([officialRow("HAD")])),{status:200});
  response=await get();data=await response.json();
  assert.equal(response.status,503);assert.equal(data.code,"OFFICIAL_ACCESS_BLOCKED");

  globalThis.fetch=async()=>new Response("blocked",{status:567});
  response=await get();data=await response.json();
  assert.equal(response.status,503);assert.equal(data.code,"OFFICIAL_ACCESS_BLOCKED");assert.match(data.error,/HTTP 567/);
 }finally{globalThis.fetch=originalFetch}
});

test("control-only official payloads are unknown manifests, not stopped sales or zero fixtures",async()=>{
 const originalFetch=globalThis.fetch,{GET}=await loadSportteryRoute();
 try{
  globalThis.fetch=async()=>Response.json({success:true,errorCode:"0",value:{vtoolsConfig:{offLineSaleStatus:1,offLineStopMessage:"抱歉，本彩种已停止销售"}}});
  const response=await GET(new Request("http://localhost/api/sporttery")),data=await response.json();
  assert.equal(response.status,502);assert.equal(data.code,"OFFICIAL_MANIFEST_UNAVAILABLE");
  assert.equal(data.sourceState.manifestState,"unknown");assert.equal(data.matches,undefined);
  assert.match(data.error,/不能据此认定停售或今日无比赛/);
  for(const pool of ["HAD","HHAD","CRS","TTG","HAFU"]){
   const state=data.sourceState.poolStatus[pool];assert.equal(state.status,"failed");assert.equal(state.matchCount,null);
   assert.deepEqual(state.issues.map(issue=>[issue.source,issue.kind]),[["primary","manifest-unavailable"],["mobile","manifest-unavailable"]]);
  }
 }finally{globalThis.fetch=originalFetch;}
});

test("partial empty lists and error text alone cannot establish empty coverage or HTTP blocking",async()=>{
 const originalFetch=globalThis.fetch,{GET}=await loadSportteryRoute();
 try{
  globalThis.fetch=async url=>new URL(String(url)).searchParams.get("poolCode")==="CRS"?Promise.reject(new Error("message says 返回 567 but no HTTP response")):Response.json(poolPayload());
  let response=await GET(new Request("http://localhost/api/sporttery")),data=await response.json();
  assert.equal(response.status,502);assert.equal(data.code,"OFFICIAL_FETCH_FAILED");assert.equal(data.sourceState.manifestState,"unknown");
  assert.equal(data.sourceState.poolStatus.CRS.issues[0].kind,"unknown");
  assert.match(data.detail,/官方赛事清单无法完整核验/);assert.doesNotMatch(data.detail,/五个玩法均读取失败/);
  globalThis.fetch=async()=>Response.json(poolPayload());
  response=await GET(new Request("http://localhost/api/sporttery"));data=await response.json();
  assert.equal(response.status,200);assert.equal(data.manifestState,"complete");assert.deepEqual(data.matches,[]);
 }finally{globalThis.fetch=originalFetch;}
});

test("official diagnostics distinguish network, timeout, unknown and schema failures",async()=>{
 const originalFetch=globalThis.fetch,{GET}=await loadSportteryRoute();
 try{
  for(const [error,kind] of [[new TypeError("fetch failed"),"network-error"],[Object.assign(new Error("aborted"),{name:"AbortError"}),"timeout"],[new Error("unexpected"),"unknown"],["unexpected rejection","unknown"]]){
   globalThis.fetch=async()=>{throw error};
   const response=await GET(new Request("http://localhost/api/sporttery")),data=await response.json();
   assert.equal(response.status,502);assert.equal(data.code,"OFFICIAL_FETCH_FAILED");
   assert.equal(data.sourceState.poolStatus.HAD.issues[0].kind,kind);
  }
  globalThis.fetch=async url=>{
   const pool=new URL(String(url)).searchParams.get("poolCode")||"HAD",row=officialRow(pool);
   delete row.homeTeamAbbName;
   return Response.json(poolPayload([row]));
  };
  const response=await GET(new Request("http://localhost/api/sporttery")),data=await response.json();
  assert.equal(response.status,502);assert.equal(data.sourceState.manifestState,"unknown");
  for(const state of Object.values(data.sourceState.poolStatus)){assert.equal(state.matchCount,null);assert.equal(state.issues[0].kind,"schema-invalid");}
 }finally{globalThis.fetch=originalFetch;}
});

test("primary HTTP blocks and mobile configuration failures retain independent diagnostics",async()=>{
 const originalFetch=globalThis.fetch,{GET}=await loadSportteryRoute();
 try{
  globalThis.fetch=async url=>new URL(String(url)).searchParams.has("poolCode")?new Response("blocked",{status:567}):Response.json({success:true,value:{vtoolsConfig:{}}});
  const response=await GET(new Request("http://localhost/api/sporttery")),data=await response.json();
  assert.equal(response.status,503);assert.equal(data.code,"OFFICIAL_ACCESS_BLOCKED");
  for(const state of Object.values(data.sourceState.poolStatus)){
   assert.equal(state.issues[0].httpStatus,567);assert.equal(state.issues[0].kind,"access-blocked");
   assert.equal(state.issues.some(issue=>issue.source==="mobile"),false,"A protected gateway must not be retried through its calculator channel");
  }
 }finally{globalThis.fetch=originalFetch;}
});

test("mobile prediction summaries swipe and forecast tables keep fixed headers and first columns",async()=>{
 const [report,table,styles,mobileStyles,page,archiveNav]=await Promise.all([
  readFile(new URL("../app/components/AiPredictionReport.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/components/MarketPredictionTable.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/reference-ui.css",import.meta.url),"utf8"),
  readFile(new URL("../app/mobile-ui.css",import.meta.url),"utf8"),
  readFile(new URL("../app/components/SiteShell.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/components/ArchiveNavLink.tsx",import.meta.url),"utf8"),
 ]);
 assert.match(report,/左右滑动查看 5 类预测/);
 assert.match(report,/role="region"/);
 assert.match(table,/左右滑动查看完整预测数据/);
 assert.doesNotMatch(table,/手机端按场次展示全部预测/);
 assert.doesNotMatch(table,/fetch\(/,"The display table must not repeat official requests");
 assert.match(styles,/\.prediction-overview-grid\{display:flex!important/);
 assert.match(styles,/scroll-snap-type:x mandatory/);
 assert.match(styles,/touch-action:pan-x pan-y/);
 assert.match(styles,/\.market-forecast-table th:nth-child\(9\).*width:230px!important/);
 assert.doesNotMatch(mobileStyles,/\.market-forecast-table tr\{display:grid!important/);
 assert.match(mobileStyles,/\.market-forecast-wrap\{max-height:min\(70dvh,640px\)!important;overflow:auto!important/);
 assert.match(mobileStyles,/tbody td:first-child\{position:sticky!important;left:0/);
 assert.match(mobileStyles,/thead th:first-child\{position:sticky!important;top:0;left:0/);
 assert.match(mobileStyles,/\.topbar\.compact-nav nav a>span\{font-size:20px!important/);
 assert.match(page,/view: "matches", href: "\/matches", icon: "▣", label: "今日比赛"/);
 assert.match(archiveNav,/<span aria-hidden="true">▤<\/span><b>盘后回溯<\/b>/);
});

test("repair uses each latest official list instead of reviving removed fixtures",async()=>{
 const originalFetch=globalThis.fetch,{GET}=await loadSportteryRoute(),counts=new Map();
 try{
  globalThis.fetch=async url=>{
   const pool=new URL(String(url)).searchParams.get("poolCode");assert.ok(pool,"valid empty official lists must not trigger another source");
   const count=(counts.get(pool)||0)+1;counts.set(pool,count);
   return Response.json(poolPayload(count===1?[officialRow(pool)]:[]));
  };
  const response=await GET(new Request("http://localhost/api/sporttery?repairMissing=1")),data=await response.json();
  assert.equal(response.status,200);assert.equal(data.manifestState,"complete");assert.deepEqual(data.matches,[]);
  for(const state of Object.values(data.poolStatus)){assert.equal(state.matchCount,0);assert.ok(Number.isFinite(Date.parse(state.observedAt)));assert.ok(Date.parse(state.observedAt)<=Date.parse(data.fetchedAt));}
  assert.deepEqual([...counts.values()],[2,2,2,2,2]);
 }finally{globalThis.fetch=originalFetch;}
});

test("mobile prediction fallback derives a traceable baseline only from official markets",async()=>{
 const source=await readFile(new URL("../app/official-prediction-fallback.ts",import.meta.url),"utf8"),javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,{buildOfficialPredictionFallback}=await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}#${Date.now()}-${Math.random()}`);
 const keys=["胜平负","让球胜平负","比分","总进球数","半全场"],match={id:"周六001",matchId:"m1",officialMatchId:"m1",salesDate:"2026-09-19",matchDate:"2026-09-19",time:"20:00:00",home:"主队",away:"客队",league:"测试联赛",handicap:"-1",quoteState:"fresh",marketStatus:Object.fromEntries(keys.map(key=>[key,"available"])),marketEligibility:Object.fromEntries(keys.map(key=>[key,{qualification:"qualified"}])),marketOdds:{"胜平负":[2.1,3.2,3.4],"让球胜平负":[3.1,3.4,1.9],"比分":[7.2],"总进球数":[20,8,3.3,3.2,5,10,18,25],"半全场":[3,12,30,5,6,10,20,11,8]}};
 const now=new Date().toISOString();match.marketSource=Object.fromEntries(keys.map(key=>[key,{observedAt:now}]));
 const fallback=buildOfficialPredictionFallback([match],now),report=fallback.reports[0];
 assert.equal(fallback.reports.length,1);assert.match(fallback.version.predictionId,/^official-browser-/);assert.equal(report.companies.length,0);assert.equal(report.marketSignal.hhadAvailable,true);assert.equal(report.marketSignal.officialHandicap,"-1");assert.equal(report.marketSignal.officialOdds[0],2.1);assert.ok(report.scores.length>0);assert.ok(Math.abs(report.marketProbabilities.reduce((sum,value)=>sum+value,0)-100)<0.001);
 for(const [row,time,error] of [[{...match,quoteState:"stale"},now],[match,new Date(Date.now()-300001).toISOString()],[match,""],[match,new Date(Date.now()+60000).toISOString()],[{...match,marketEligibility:{}},now],...["OFFICIAL_ACCESS_BLOCKED","OFFICIAL_MANIFEST_UNAVAILABLE","OFFICIAL_FETCH_FAILED"].map(code=>[match,now,{code}]),[match,now,{status:409}]]){
  const blocked=buildOfficialPredictionFallback([row],time,error);assert.equal(blocked.reports.length,0);assert.equal(blocked.coverage.unavailableMatches,1);
 }
 const partial=buildOfficialPredictionFallback([{...match,marketStatus:{...match.marketStatus,"总进球数":"failed","让球胜平负":"failed","半全场":"failed"}}],now).reports[0];
 assert.equal(partial.totalGoalProbabilities,undefined);assert.equal(partial.hhadProbabilities,undefined);assert.equal(partial.halfFullProbabilities,undefined);assert.deepEqual(partial.marketSignal.modeledTotalGoals,[]);assert.deepEqual(partial.marketSignal.officialHhadOdds,[]);
 const invalid=buildOfficialPredictionFallback([{...match,marketOdds:{...match.marketOdds,"总进球数":[0,8,3.3,3.2,5,10,18,25]}}],now).reports[0];assert.equal(invalid.totalGoalProbabilities,undefined);
 for(const observedAt of [undefined,"bad-time",new Date(Date.now()-300001).toISOString(),new Date(Date.now()+60000).toISOString()]){
  const partial=buildOfficialPredictionFallback([{...match,marketSource:{...match.marketSource,"总进球数":{observedAt}}}],now).reports[0];
  assert.equal(partial.totalGoalProbabilities,undefined);assert.deepEqual(partial.marketSignal.modeledTotalGoals,[]);
 }
 const short=buildOfficialPredictionFallback([{...match,marketOdds:{...match.marketOdds,"总进球数":[2,3],"半全场":[2,3]}}],now).reports[0];assert.deepEqual(short.marketSignal.modeledTotalGoals,[]);assert.deepEqual(short.marketSignal.modeledHalfFull,[]);
});

test("match-board merge keeps omitted or failed quotes unavailable for selection",async()=>{
 const page=await readWorkspaceSource(),snippet=page.slice(page.indexOf("export const matchCacheKey"),page.indexOf("export const fairMarketPoints")).replaceAll("export ",""),javascript=ts.transpileModule(snippet,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const {mergeOfficialMatches,oddsFor}=new Function(`${javascript};return {mergeOfficialMatches,oddsFor};`)();
 const match={id:"周六001",officialMatchId:"m1",salesDate:"2026-09-19",marketOdds:{"胜平负":[2,3,4]},marketStatus:{"胜平负":"available"},marketEligibility:{"胜平负":{qualification:"qualified"}}};
 assert.equal(oddsFor(mergeOfficialMatches([match],[])[0],"胜平负"),null);
 assert.equal(oddsFor(mergeOfficialMatches([match],[{...match,marketOdds:{"胜平负":null},marketStatus:{"胜平负":"failed"}}])[0],"胜平负"),null);
 assert.equal(oddsFor(mergeOfficialMatches([match],[{...match,marketEligibility:{"胜平负":{qualification:"unknown"}}}])[0],"胜平负"),null);
 assert.deepEqual(oddsFor(mergeOfficialMatches([match],[match])[0],"胜平负"),[2,3,4]);
 assert.equal(mergeOfficialMatches([],[match])[0].quoteState,"fresh");
 assert.doesNotMatch(page,/buildOfficialPredictionFallback\(/,"A failed server prediction must not create a new browser-only current version");
 assert.match(page,/新预测未完成：[\s\S]*没有服务端不可变版本/);
});

test("production match board has explicit official-data states and no demo fallback",async()=>{
 const page=await readWorkspaceSource();
 assert.match(page,/type DataState\s*=\s*"loading"[\s\S]*"success"[\s\S]*"stale"[\s\S]*"empty"[\s\S]*"error"/);
 assert.match(page,/liveMatches\.slice\(\)\.sort\(compareMatchesByDateAndSequence\)/);
 assert.match(page,/const compareMatchesByDateAndSequence\s*=/);
 assert.match(page,/const oddsFor[\s\S]*return null/);
 assert.match(page,/暂未开售或暂无官方赔率/);
 assert.match(page,/全部赔率选择和新预测已暂停/);
 assert.match(page,/internalError instanceof OfficialAccessBlockedError/);
 assert.match(page,/刷新不能解除限制/);
 assert.match(page,/<details>\s*<summary>查看读取失败详情<\/summary>/);
 assert.doesNotMatch(page,/liveMatches\.length\?liveMatches:demoMatches/);
 assert.doesNotMatch(page,/demoMatches|比赛研究样例/);
 assert.doesNotMatch(page,/const marketOdds:Record<Market,number\[\]>/);
});

test("post-match archive keeps evidence, labels and AI review safeguards",async()=>{
 const [archive,engine,api]=await Promise.all([
  readFile(new URL("../app/components/PredictionArchive.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/post-match-review.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/api/predictions/post-match-review/route.ts",import.meta.url),"utf8"),
 ]);
 assert.match(archive,/复盘摘要/);
 assert.doesNotMatch(archive,/<th>复盘标签<\/th>/);
 assert.match(archive,/生成AI深度复盘/);
 assert.match(engine,/正常兑现/);
 assert.match(engine,/合理偏差/);
 assert.match(engine,/爆冷/);
 assert.match(engine,/strongHadReversal/);
 assert.match(engine,/strongHhadReversal/);
 assert.match(engine,/forecastOutcome\.probability>50/);
 assert.match(engine,/totalReasonableDeviation=actualGoalRank===2/);
 assert.match(engine,/总进球合理偏差/);
 assert.match(engine,/totalOutsideTopTwo/);
 assert.match(engine,/赛中事件待核验/);
 assert.match(api,/不得声称发生红牌、点球、伤退/);
 assert.match(api,/unsupportedEventClaim/);
});

test("post-match deviation rules distinguish strong reversals and total-goal ranks",async()=>{
 const source=await readFile(new URL("../app/post-match-review.ts",import.meta.url),"utf8");
 const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const {buildPostMatchReview}=await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
 const base={id:"周一001",home:"主队",away:"客队",completeness:10,handicap:"-1",hadProbabilities:[{score:"胜",probability:55},{score:"平",probability:25},{score:"负",probability:20}],hhadProbabilities:[{score:"让胜",probability:45},{score:"让平",probability:30},{score:"让负",probability:25}],totalGoalProbabilities:[{score:"2球",probability:40},{score:"3球",probability:30},{score:"1球",probability:20},{score:"4球",probability:10}]};
 assert.equal(buildPostMatchReview(base,{fullScore:"0:1",handicap:"-1"}).primary,"爆冷");
 assert.equal(buildPostMatchReview({...base,hhadProbabilities:[{score:"让胜",probability:55},{score:"让平",probability:25},{score:"让负",probability:20}],handicap:"-2"},{fullScore:"1:0",handicap:"-2"}).primary,"爆冷");
 const second=buildPostMatchReview(base,{fullScore:"2:1",handicap:"-1"});
 assert.equal(second.totalMatched,false);
 assert.equal(second.totalGoalRank,2);
 assert.equal(second.totalTopTwoMatched,true);
 assert.match(second.summary,/次选命中/);
 assert.ok(second.causeTags.includes("总进球合理偏差"));
 assert.ok(!second.improvementAreas.includes("总进球校准"));
 const high=buildPostMatchReview(base,{fullScore:"4:1",handicap:"-1"});
 assert.equal(high.totalTopTwoMatched,false);
 assert.ok(high.causeTags.includes("大球偏离"));
 assert.ok(!high.improvementAreas.includes("总进球校准"));assert.equal(high.predictability,"未评估");
 const low=buildPostMatchReview(base,{fullScore:"0:0",handicap:"-1"});
 assert.ok(low.causeTags.includes("小球偏离"));
});

test("historical calibration is wired into predictions without treating missing fields as misses",async()=>{
 const [archive,engine,predictions,page,ai,calibration]=await Promise.all([
  readFile(new URL("../app/components/PredictionArchive.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/post-match-review.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/api/predictions/route.ts",import.meta.url),"utf8"),
  readWorkspaceSource(),
  readFile(new URL("../app/api/predictions/ai/route.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/calibration-service.ts",import.meta.url),"utf8"),
 ]);
 assert.match(archive,/probabilityTemperature/);
 assert.match(archive,/未参与调参的未来测试成绩/);
 assert.match(engine,/predictedGoalPoint&&!totalTopTwoMatched/);
 assert.match(engine,/单场结果不证明排序/);
 assert.match(predictions,/predictFromSnapshot/);
 assert.match(predictions,/goalDispersion/);
 assert.doesNotMatch(page,/PREDICTION_CALIBRATION_STORAGE_KEY/);
 assert.match(predictions,/getPublishedCalibration/);
 assert.match(calibration,/decisionTargetAt/);
 assert.match(calibration,/selectDecisionObservations/);
 assert.equal(selectDecisionObservations([]).policy,"actual_information_not_after_fixed_target_v2");
 assert.match(calibration,/selected\.slice\(0,\s*trainEnd\)/);
 assert.match(calibration,/selected\.slice\(trainEnd,\s*calibrationEnd\)/);
 assert.match(calibration,/selected\.slice\(calibrationEnd\)/);
 assert.match(calibration,/futureTest:\s*\{\s*raw:\s*testRaw,\s*calibrated:\s*testCalibrated,\s*marketBaseline:\s*testMarket/s);
  assert.match(calibration,/promotionCandidate:\s*evaluation\.status\s*===\s*"validated"/);
  assert.match(calibration,/未来独立样本 ≥ 100/);
  assert.doesNotMatch(calibration,/flag:"wx"/);
 assert.match(ai,/resolveContextEvidence/);
 assert.match(ai,/applyEvidenceReviews/);
 assert.match(ai,/intelligenceWeightMultiplier:0/);
 assert.doesNotMatch(ai,/applyAiReviewVersion/);
});

test("small independent calibration samples keep temperature at one",async()=>{
 const policyUrl=new URL("../app/snapshot-decision-policy.js",import.meta.url).href;
 const source=(await readFile(new URL("../app/calibration-service.ts",import.meta.url),"utf8"))
  .replace('from "./prediction-model.js"',`from "${new URL("../app/prediction-model.js",import.meta.url).href}"`)
  .replace('from "./snapshot-decision-policy.js"',`from "${policyUrl}"`)
  .replace('from "./probability-evaluation.js"',`from "${new URL("../app/probability-evaluation.js",import.meta.url).href}"`)
  .replace(/import\.meta\.glob<ModelCalibrationProfile>\([^;]+\);/,"{};");
 const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const {buildCalibrationEvaluation,MIN_TEMPERATURE_CALIBRATION_MATCHES}=await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
 assert.equal(MIN_TEMPERATURE_CALIBRATION_MATCHES,30);
 const probabilities=[{score:"胜",probability:70},{score:"平",probability:20},{score:"负",probability:10}];
 const rows=Array.from({length:25},(_,index)=>{
  const date=new Date(Date.UTC(2026,8,1+index)).toISOString().slice(0,10);
  return{matchKey:`${date}|official-${index}`,league:"测试",kickoffAt:`${date}T20:00:00+08:00`,capturedAt:`${date}T19:30:00+08:00`,modelProbabilities:probabilities,marketProbabilities:probabilities,actual:"负",totalGoals:1};
 });
 const evaluation=buildCalibrationEvaluation(rows);
 assert.equal(evaluation.calibrationSampleSize,5);
 assert.equal(evaluation.probabilityTemperature,1);
 assert.equal(evaluation.status,"insufficient_data");
});

test("post-match workspace separates analysis views and deduplicates league accuracy",async()=>{
 const [archive,styles]=await Promise.all([readFile(new URL("../app/components/PredictionArchive.tsx",import.meta.url),"utf8"),readFile(new URL("../app/reference-ui.css",import.meta.url),"utf8")]);
 for(const label of ["综合回溯","比分预测","胜平负预测","让球预测","总进球数预测","半全场预测"])assert.match(archive,new RegExp(label));
 assert.match(archive,/各联赛预测正确率/);
 assert.match(archive,/metric\.total<5\?"small-sample":metric\.hits\/metric\.total>=\.9\?"very-high":metric\.hits\/metric\.total>=\.65\?"high":metric\.hits\/metric\.total>=\.4\?"medium":"low"/);
 for(const tone of ["very-high","high","medium","low","small-sample"])assert.match(styles,new RegExp(`\\.accuracy-rate\\.${tone}\\{`));
 assert.match(archive,/uniqueArchiveMatchRows\(snapshots\.filter/);
 assert.match(archive,/detailRows=drilldown\?rows\.flatMap/);
 assert.match(archive,/\.sort\(compareArchiveMatchRows\):\[\]/);
 assert.match(archive,/已有真实赛果且该预测字段完整/);
 assert.match(archive,/archive-analysis-toolbar/);
 assert.match(archive,/选择彩票日期/);
 assert.match(archive,/aria-label="盘后回溯彩票日期"/);
 assert.doesNotMatch(archive,/dateSnapshots\.map\(snapshot/);
 assert.match(archive,/setSelectedDate\(event\.target\.value\);setSelectedKey\(""\)/);
 assert.match(archive,/league-accuracy-panel[^]*?<details><summary>/);
 assert.doesNotMatch(archive,/league-accuracy-panel[^]*?<details open>/);
 assert.match(archive,/archive-match-review[^]*?场次复盘摘要/);
 assert.match(archive,/function LeagueAccuracyPanel\(\{rows\}/);
 assert.match(archive,/aria-label="联赛正确率预测类型"/);
 assert.match(archive,/aria-label="正确率联赛筛选"/);
 assert.match(archive,/accuracy-drilldown/);
 assert.match(archive,/预测与实际结果明细/);
 assert.match(archive,/archive-match-workspace/);
 assert.match(archive,/aria-label="场次复盘预测类型"/);
 assert.match(styles,/archive-page>\.prediction-disclaimer[^}]*display:none!important/);
 assert.match(archive,/archive-match-meta/);
 assert.match(archive,/archive-match-league/);
 assert.match(archive,/data-tone=\{leagueTone\(match\.league\)\}/);
 assert.match(archive,/kickoffTime\(match\)/);
 assert.match(archive,/archive-review-table/);
 assert.match(archive,/ReviewEvidencePopover/);
 assert.match(archive,/createPortal/);
 assert.match(archive,/onMouseEnter=\{\(\)=>setOpen\(true\)\}/);
 assert.match(archive,/PredictionTableCell market="score"/);
 assert.match(archive,/PredictionTableCell market="half-full"/);
 assert.match(archive,/market="score"[^>]*candidates=\{3\}/);
 assert.match(archive,/market="total"[^>]*candidates=\{2\}/);
 assert.match(archive,/market="half-full"[^>]*candidates=\{2\}/);
 assert.match(archive,/actualIndex===0\?"主选命中"/);
 assert.match(archive,/secondaryEligible\?"次选命中"/);
 assert.match(archive,/backupEligible\?"备选命中"/);
 assert.match(archive,/normalizeHhadOutcome/);
 assert.match(archive,/market==="hhad"\?normalizeHhadOutcome\(value\)/);
 assert.match(archive,/actualHhadLabel=actualHhad\?\.replace\(\/\^让\/,""\)/);
 assert.match(archive,/allPicks\[0\]\?\.probability>50/);
 assert.match(archive,/market==="total"\|\|market==="half-full"/);
 assert.match(archive,/"总进球主选",stats\?\.goalPrimary/);
 assert.match(archive,/"总进球主选\+次选",stats\?\.goalCovered/);
 assert.match(archive,/"半全场主选\+次选",stats\?\.halfFullCovered/);
 assert.match(archive,/actualGoal>predictedGoal\?"大球偏离":"小球偏离"/);
 assert.doesNotMatch(archive,/预测置信度/);
 assert.match(archive,/pending=\{!result\}/);
 assert.doesNotMatch(archive,/ForecastResultCell/);
 assert.match(styles,/archive-review-table th:nth-child\(8\)\{width:698px\}/);
 assert.match(styles,/td:has\(>\.prediction-table-result\.primary-hit\)/);
 assert.match(styles,/\.prediction-status\.secondary-hit\{background:#1687f8/);
 assert.match(styles,/\.prediction-status\.backup-hit\{background:#895dcc/);
 assert.match(styles,/\.focused-picks \.pick-rank-3/);
 assert.match(styles,/archive-review-summary>p\{display:block;overflow:visible/);
 assert.match(styles,/archive-evidence-popover\{position:fixed;z-index:1000/);
assert.match(styles,/archive-review-table th:nth-child\(1\)\{width:58px\}[^]*nth-child\(2\)\{width:82px\}[^]*nth-child\(n\+3\):nth-child\(-n\+7\)\{width:90px\}[^]*nth-child\(8\)\{width:492px\}/);
assert.match(styles,/archive-review-table th,\.archive-review-table td\{box-sizing:border-box\}/);
assert.match(styles,/forecast-view-had th:nth-child\(1\)[^]*width:4\.4%!important[^]*forecast-view-total th:nth-child\(3\)[^]*width:6\.6%!important/);
});

test("market probability highlights remain visible on zebra and hovered rows",async()=>{
 const [table,styles]=await Promise.all([readFile(new URL("../app/components/MarketPredictionTable.tsx",import.meta.url),"utf8"),readFile(new URL("../app/reference-ui.css",import.meta.url),"utf8")]);
 assert.match(styles,/tr:nth-child\(even\) td\.high-prob,[^]*tr:hover td\.high-prob\s*\{background:#fff176!important/);
 assert.match(table,/expandedExpectations/);
 assert.match(table,/aria-expanded=\{expanded\}/);
 assert.match(table,/展开全部/);
 assert.match(table,/前2\s*<br\s*\/>\s*概率和/);
 assert.match(table,/goalCoverage\s*>\s*50\s*\?\s*"goal-top2"/);
 assert.match(table,/rank\s*===\s*0\s*\?\s*"goal-prob-first"\s*:\s*rank\s*===\s*1\s*\?\s*"goal-prob-second"/);
 assert.match(table,/goalPicks\.map\(\(?item\)?\s*=>\s*item\.label\)\.join\(" \/ "\)/);
 assert.match(table,/SCORE_TOP_TWO_COVERAGE_THRESHOLD\s*=\s*25/);
 assert.match(table,/SCORE_SINGLE_PROBABILITY_THRESHOLD\s*=\s*15/);
 assert.match(table,/scoreTopTwoCoverage\s*>\s*SCORE_TOP_TWO_COVERAGE_THRESHOLD\s*\?\s*"score-coverage-high"/);
 assert.match(table,/item\?\.probability\s*\|\|\s*0\)\s*>\s*SCORE_SINGLE_PROBABILITY_THRESHOLD/);
 assert.match(styles,/forecast-expectation\.expanded>span[^]*-webkit-line-clamp:unset!important/);
 assert.match(styles,/forecast-view-score td\.forecast-expectation\{text-align:left!important\}/);
});

test("daily purchase drafts preserve fixed definitions while screening the formal portfolio",()=>{
 const reports=Array.from({length:8},(_,index)=>({id:`周一00${index+1}`,officialMatchId:`official-${index+1}`,officialMappingStatus:"verified",salesDate:"2026-09-08",matchDate:"2026-09-08",kickoffAt:"2026-09-08T20:00:00+08:00",sourceFetchedAt:"2026-09-08T16:55:00+08:00",league:"测试联赛",home:`主队${index+1}`,away:`客队${index+1}`,matchStatus:"Selling",isMock:false,handicap:"-1",hadProbabilities:[{score:"胜",probability:70-index*.2},{score:"平",probability:16},{score:"负",probability:14+index*.2}],hhadProbabilities:[{score:"让胜",probability:35},{score:"让平",probability:35-index*.2},{score:"让负",probability:30+index*.2}],fullScoreDistribution:scoreGridFixture({"1:0":35-index*.2,"2:0":35,"1:1":16,"0:1":14+index*.2}),totalGoalProbabilities:completePoints(MARKET_META.total.labels,{"1球":49,"2球":51}),halfFullProbabilities:completePoints(MARKET_META.halfFull.labels,{"胜胜":36,"平胜":24,"平平":14})}));
 const qualified=(marketCode,handicap)=>({marketCode,salesStatus:"Selling",qualification:"qualified",handicap,allowedPassCounts:[1,2,3,4,5,6,7,8],cutoffAt:"2026-09-08T19:50:00+08:00",ruleVersion:"test"});
 const officialMatches=reports.map(report=>({id:report.id,officialMatchId:report.officialMatchId,salesDate:report.salesDate,matchDate:report.matchDate,kickoffAt:report.kickoffAt,matchStatus:"Selling",marketOdds:{"胜平负":[2.1,3.2,4],"让球胜平负":[3.1,3.4,1.9],"比分":Array(31).fill(9),"总进球数":[24,12,7,6.4,10,16,24,32],"半全场":[4,12,25,5,6,14,18,13,7]},marketEligibility:{"胜平负":qualified("HAD"),"让球胜平负":qualified("HHAD","-1"),"比分":qualified("CRS"),"总进球数":qualified("TTG"),"半全场":qualified("HAFU")}}));
 const set=generatePurchasePlans({date:"2026-09-08",reports,officialMatches,generatedAt:"2026-09-08T09:00:00.000Z"});
 assert.equal(set.plans.length,21);assert.deepEqual(set.plans.map(plan=>plan.id),["score-double-3","score-single-2","score-double-2","score-single-3","total-double-3","total-double-2","total-single-2","draw-or-handicap-draw-2","draw-or-handicap-draw-3","result-mixed-3","result-mixed-4","result-mixed-5","had-safe-2","tenfold-safe-2","tenfold-safe-3","tenfold-safe-4","half-full-double-3","twofold-a","twofold-b","twofold-c","half-full-double-2"]);
 const accepted=set.plans.filter(plan=>plan.status==="pending"),policy=DEFAULT_RECOMMENDATION_POLICY;
 assert.ok(accepted.length>0,"A complete positive-EV fixture must exercise accepted tickets");
 assert.ok(accepted.length<=policy.maxTickets);
 assert.equal(set.decisionSummary.coverage.missingEligibleCount,0);
 assert.equal(set.decisionSummary.evaluated,true);
 assert.equal(set.riskSelection.selected,accepted.length);
 assert.ok(set.portfolio.totalStake<=policy.dailyBudget);
 assert.equal(set.portfolio.duplicateTickets,0);
 assert.equal(new Set(accepted.map(plan=>canonicalTicketKey(plan.items))).size,accepted.length);
 for(const exposure of set.portfolio.fixtures)assert.ok(exposure.stake<=policy.maxFixtureStake);
 for(const exposure of set.portfolio.leagues)assert.ok(exposure.stake<=policy.maxLeagueStake);
 for(let a=0;a<accepted.length;a++)for(let b=a+1;b<accepted.length;b++)assert.ok(accepted[a].items.filter(item=>accepted[b].items.some(other=>ticketFixtureKey(item)===ticketFixtureKey(other))).length<=policy.maxSharedFixturesPerPair);
 const fixtureTickets=new Map();
 for(const plan of accepted){
  const definition=PURCHASE_PLAN_DEFINITIONS.find(item=>item.id===plan.id),economics=calculateTicketEconomics(plan.items),assessment=assessRecommendation(plan.items);
  assert.equal(plan.items.length,definition.matches);
  assert.equal(plan.passName,definition.matches+"串1");
  assert.equal(plan.betCount,definition.selections**definition.matches);
  assert.equal(plan.stake,plan.betCount*2);
  assert.equal(new Set(plan.items.map(ticketFixtureKey)).size,plan.items.length);
  assert.ok(plan.items.every(item=>definition.markets.includes(item.market)&&item.market!=="halfFull"&&item.picks.length===definition.selections&&item.probability>=(definition.minLegProbability||0)));
  if(definition.allowedPicks)assert.ok(plan.items.every(item=>item.picks.every(pick=>definition.allowedPicks.includes(pick.pick))));
  if(definition.mixed)assert.ok(new Set(plan.items.map(item=>item.market)).size>=2);
  assert.ok(assessment.eligible);
  assert.ok(economics.expectedROI>=policy.minExpectedROI);
  assert.ok(assessment.sensitivity.low.expectedProfit>=0);
  assert.ok(plan.minWinningProfit>=(definition.minProfitMultiplier||0)*plan.stake);
  if(Number.isFinite(definition.targetNetProfit)){assert.equal(definition.targetProfitTolerance,0);assert.ok(plan.minWinningProfit>=definition.targetNetProfit);}
  assert.ok(plan.maxWinningReturn>=plan.minWinningReturn);
  for(const item of plan.items)fixtureTickets.set(ticketFixtureKey(item),(fixtureTickets.get(ticketFixtureKey(item))||0)+1);
 }
 assert.ok([...fixtureTickets.values()].every(count=>count<=policy.maxTicketsPerFixture));
 for(const plan of set.plans.filter(plan=>plan.id.startsWith("half-full-"))){assert.equal(plan.status,"unavailable");assert.equal(plan.reasonCode,"research_only");assert.deepEqual(plan.items,[]);}
 assert.ok(!set.plans.some(plan=>plan.id==="had-double-2"||plan.id==="total-adjacent-double-2"));
 assert.ok(PURCHASE_PLAN_DEFINITIONS.every(definition=>/单选|双选/.test(definition.title)&&/\d串1/.test(definition.title)));
 const first=accepted[0];
 const results=first.items.map(item=>{
  const pick=item.picks[0].pick,fullScore=item.market==="score"?({"胜其他":"6:0","平其他":"4:4","负其他":"0:6"}[pick]||pick):item.market==="total"?parseInt(pick)+":0":item.market==="hhad"?{"让胜":"2:0","让平":"1:0","让负":"0:0"}[pick]:{"胜":"1:0","平":"0:0","负":"0:1"}[pick];
  return {id:item.matchId,matchId:item.officialMatchId,date:"2026-09-08",fullScore,scoreResult:item.market==="score"?pick:undefined,hhadResult:item.market==="hhad"?pick.replace("让",""):undefined,status:"settled"};
 });
 assert.equal(settlePurchasePlan(first,results).status,"won");
 const budgetBlocked=generatePurchasePlans({date:"2026-09-08",reports,officialMatches,generatedAt:"2026-09-08T09:00:00.000Z",riskPolicy:{...policy,dailyBudget:0}});
 assert.ok(budgetBlocked.riskSelection.modelEligibleCount>0,"Zero budget must reject valid candidates, not hide missing data");
 assert.equal(budgetBlocked.riskSelection.selected,0);
 assert.equal(budgetBlocked.portfolio.totalStake,0);
 assert.ok(budgetBlocked.plans.every(plan=>plan.status==="unavailable"));
 const incomplete=reports.map(report=>({...report,fullScoreDistribution:report.fullScoreDistribution.slice(0,168),hadProbabilities:report.hadProbabilities.slice(0,2),hhadProbabilities:report.hhadProbabilities.slice(0,2),totalGoalProbabilities:report.totalGoalProbabilities.slice(0,7)}));
 const incompleteSet=generatePurchasePlans({date:"2026-09-08",reports:incomplete,officialMatches,generatedAt:"2026-09-08T09:00:00.000Z"});
 assert.equal(incompleteSet.riskSelection.selected,0);assert.equal(incompleteSet.decisionSummary.noBet,false);assert.equal(incompleteSet.decisionSummary.coverage.missingEligibleCount,reports.length);
 const staleSet=generatePurchasePlans({date:"2026-09-08",reports:reports.map(report=>({...report,sourceFetchedAt:"2026-09-08T14:00:00+08:00"})),officialMatches,generatedAt:"2026-09-08T09:00:00.000Z"});
 assert.equal(staleSet.riskSelection.selected,0);assert.equal(staleSet.decisionSummary.noBet,false);assert.equal(staleSet.decisionSummary.coverage.missingEligibleCount,reports.length);
 const closed=officialMatches.map(match=>({...match,marketEligibility:Object.fromEntries(Object.entries(match.marketEligibility).map(([name,qualification])=>[name,{...qualification,cutoffAt:"2026-09-08T17:00:00+08:00"}]))}));
 const closedSet=generatePurchasePlans({date:"2026-09-08",reports,officialMatches:closed,generatedAt:"2026-09-08T09:00:00.000Z"});
 assert.equal(closedSet.riskSelection.selected,0);assert.equal(closedSet.portfolio.totalStake,0);
});

test("new fixed tickets exclude negative minimum profit and show per-match expected returns",()=>{
 const leg=calculatePurchaseLegReturns({picks:[{pick:"0球",probability:55,odd:1.2},{pick:"1球",probability:45,odd:1.3}]});
 assert.equal(Number(leg.expectedReturn.toFixed(2)),2.49);
 assert.deepEqual({stake:leg.stake,minWinningReturn:leg.minWinningReturn,maxWinningReturn:leg.maxWinningReturn,minWinningProfit:leg.minWinningProfit,maxWinningProfit:leg.maxWinningProfit},{stake:4,minWinningReturn:2.4,maxWinningReturn:2.6,minWinningProfit:-1.6,maxWinningProfit:-1.4});
 const reports=[1,2].map(index=>({id:`周一00${index}`,officialMatchId:`official-${index}`,officialMappingStatus:"verified",salesDate:"2026-09-08",matchDate:"2026-09-08",kickoffAt:"2026-09-08T20:00:00+08:00",sourceFetchedAt:"2026-09-08T16:55:00+08:00",home:`主队${index}`,away:`客队${index}`,matchStatus:"Selling",totalGoalProbabilities:completePoints(MARKET_META.total.labels,{"0球":55,"1球":45})}));
 const officialMatches=reports.map(report=>({officialMatchId:report.officialMatchId,salesDate:report.salesDate,kickoffAt:report.kickoffAt,matchStatus:"Selling",marketOdds:{"总进球数":[1.2,1.3,0,0,0,0,0,0]},marketEligibility:{"总进球数":{marketCode:"TTG",salesStatus:"Selling",qualification:"qualified",allowedPassCounts:[2],cutoffAt:"2026-09-08T19:50:00+08:00"}}}));
 const set=generatePurchasePlans({date:"2026-09-08",reports,officialMatches,generatedAt:"2026-09-08T17:00:00+08:00"});
 assert.equal(set.plans.find(plan=>plan.id==="total-double-2").status,"unavailable");
 assert.equal(set.decisionSummary.coverage.missingEligibleCount,0);
 assert.equal(set.decisionSummary.noBet,false,"单选命中后不亏的组合不再因负期望被排除");
 assert.ok(set.decisionSummary.rejectionCounts.nonPositiveEV>0,"负期望仍保留为审计指标");
 assert.ok(set.plans.filter(plan=>plan.id.startsWith("twofold-")).every(plan=>plan.status==="unavailable"),"低赔率不得被包装成2倍盈利票");
 assert.ok(set.plans.filter(plan=>plan.status!=="unavailable").every(plan=>plan.minWinningProfit>=0));
});

test("official identity and market qualification gate purchasable recommendations",()=>{
 const eligibility=single=>({"胜平负":{marketCode:"HAD",salesStatus:"Selling",qualification:"qualified",supportsSingle:single,allowedPassCounts:single?[1,2,3,4,5,6,7,8]:[2,3,4,5,6,7,8],cutoffAt:null,ruleVersion:"test"}});
 const report={id:"周三001",officialMatchId:"new-id",officialMappingStatus:"verified",salesDate:"2026-09-09",matchDate:"2026-09-09",kickoffAt:"2026-09-09T20:00:00+08:00",sourceFetchedAt:"2026-09-09T16:55:00+08:00",home:"甲",away:"乙",matchStatus:"Selling",hadProbabilities:[{score:"胜",probability:70}]};
 const wrongDate={id:"周三001",officialMatchId:"old-id",salesDate:"2026-09-02",matchDate:"2026-09-02",matchStatus:"Selling",marketOdds:{"胜平负":[2.1,3,4]},marketEligibility:eligibility(true)};
 const noSingle={id:"周三001",officialMatchId:"new-id",salesDate:"2026-09-09",matchDate:"2026-09-09",matchStatus:"Selling",marketOdds:{"胜平负":[2.1,3,4]},marketEligibility:eligibility(false)};
 const set=generatePurchasePlans({date:"2026-09-09",reports:[report],officialMatches:[wrongDate,noSingle],generatedAt:"2026-09-09T17:00:00+08:00"});
 assert.ok(set.plans.every(plan=>plan.status==="unavailable"),"不支持单关的玩法不能生成单场方案，且相同场次编号不能跨日串场");
});

test("daily purchase history is split into modules with independent hit-rate and return summaries",()=>{
 assert.deepEqual(PURCHASE_PLAN_MODULES.map(module=>module.id),["score","total","result","draw","halfFull","tenfold","twofold"]);
 const summary=summarizePurchasePlanModules([{plans:[
  {id:"score-double-3",status:"won",stake:16,simulatedReturn:90},
  {id:"score-single-2",status:"lost",stake:2,simulatedReturn:0},
  {id:"total-double-2",status:"pending",stake:8,simulatedReturn:0},
  {id:"result-mixed-3",status:"void_lost",stake:2,simulatedReturn:0},
  {id:"draw-or-handicap-draw-2",status:"corrected_won",stake:2,simulatedReturn:12},
  {id:"half-full-double-3",status:"field_pending",stake:16,simulatedReturn:0},
  {id:"tenfold-safe-2",status:"corrected_won",stake:2,simulatedReturn:22},
 ]}]);
 assert.deepEqual(summary.score,{settled:2,refunded:0,won:1,rate:50,stake:18,returned:90,net:72});
 assert.deepEqual(summary.total,{settled:0,refunded:0,won:0,rate:0,stake:0,returned:0,net:0});
 assert.deepEqual(summary.result,{settled:1,refunded:0,won:0,rate:0,stake:2,returned:0,net:-2});
 assert.deepEqual(summary.draw,{settled:1,refunded:0,won:1,rate:100,stake:2,returned:12,net:10});
 assert.deepEqual(summary.halfFull,{settled:0,refunded:0,won:0,rate:0,stake:0,returned:0,net:0});
 assert.deepEqual(summary.tenfold,{settled:1,refunded:0,won:1,rate:100,stake:2,returned:22,net:20});
});

test("each fixed ticket has independent cross-date settlement and visible pending rows",()=>{
 const sets=[
  {snapshotId:"purchase-a",date:"2026-09-21",generatedAt:"2026-09-21T09:00:00Z",plans:[{id:"total-double-2",status:"won",stake:8,simulatedReturn:25,items:[{matchId:"周一001"}]}]},
  {snapshotId:"purchase-b",date:"2026-09-22",generatedAt:"2026-09-22T09:00:00Z",plans:[{id:"total-double-2",status:"pending",stake:8,items:[{matchId:"周二001"}]}]},
  {snapshotId:"purchase-c",date:"2026-09-23",generatedAt:"2026-09-23T09:00:00Z",plans:[{id:"total-double-2",status:"lost",stake:8,simulatedReturn:0,items:[{matchId:"周三001"}]}]},
 ];
 const record=summarizePurchasePlanDefinitions(sets)["total-double-2"];
 assert.equal(record.rows.length,3);
 assert.deepEqual({settled:record.settled,won:record.won,rate:record.rate,stake:record.stake,returned:record.returned,net:record.net},{settled:2,won:1,rate:50,stake:16,returned:25,net:9});
});

test("identical adjacent total-goal tickets count once per saved batch without erasing distinct history",()=>{
 const items=[
  {officialMatchId:"101",salesDate:"2026-09-21",market:"total",picks:[{pick:"2球",odd:4},{pick:"3球",odd:3}]},
  {officialMatchId:"102",salesDate:"2026-09-21",market:"total",picks:[{pick:"1球",odd:5},{pick:"2球",odd:4}]},
 ];
 const canonical={id:"total-double-2",status:"won",passName:"2串1",stake:8,simulatedReturn:24,items};
 const duplicate={...canonical,id:"total-adjacent-double-2",status:"lost",simulatedReturn:0,items:[
  {...items[1],picks:[...items[1].picks].reverse()},
  {...items[0],picks:[...items[0].picks].reverse()},
 ]};
 const distinct={...duplicate,items:[items[0],{...items[1],picks:[{pick:"2球",odd:4},{pick:"3球",odd:3}]}]};
 const first={snapshotId:"batch-a",date:"2026-09-21",generatedAt:"2026-09-21T09:00:00Z",plans:[canonical,duplicate]};
 const second={snapshotId:"batch-b",date:"2026-09-22",generatedAt:"2026-09-22T09:00:00Z",plans:[canonical,distinct]};
 assert.deepEqual(deduplicatePurchasePlans(first.plans).map(plan=>plan.id),["total-double-2"]);
 assert.equal(first.plans.length,2,"immutable source batch must not be mutated");
 assert.deepEqual(deduplicatePurchasePlans(second.plans).map(plan=>plan.id),["total-double-2","total-double-2"]);
 assert.equal(deduplicatePurchasePlans(second.plans)[1].originPlanId,"total-adjacent-double-2");
 const days=summarizePurchasePlanDays([first,second]);
 assert.equal(days["2026-09-21"].tickets,1);
 assert.equal(days["2026-09-22"].tickets,2);
 const total=summarizePurchasePlanModules([first,second]).total;
 assert.deepEqual({settled:total.settled,won:total.won,stake:total.stake,returned:total.returned},{settled:3,won:2,stake:24,returned:48});
 const byType=summarizePurchasePlanDefinitions([first,second]);
 assert.equal(byType["total-double-2"].rows.length,3);
 assert.equal(byType["total-adjacent-double-2"],undefined);
});

test("the sole September 19 adjacent-goal ticket is merged into total-goal double history",async()=>{
 const index=JSON.parse(await readFile(new URL("../data/generated-prediction-snapshot-index.json",import.meta.url),"utf8"));
 const snapshot=index.purchasePlanSnapshots.find(item=>item.planSet?.date==="2026-09-19");
 assert.ok(snapshot);
 const plans=deduplicatePurchasePlans(snapshot.planSet.plans);
 assert.ok(plans.some(plan=>plan.id==="total-double-2"&&plan.originPlanId==="total-adjacent-double-2"));
 assert.ok(!plans.some(plan=>plan.id==="total-adjacent-double-2"));
 const history=summarizePurchasePlanDefinitions([{...snapshot.planSet,snapshotId:snapshot.snapshotId}]);
 assert.equal(history["total-double-2"].rows.length,1);
});

test("settlement keeps missing fields pending and isolates official ids by date",()=>{
 const plan={id:"p",status:"pending",stake:2,theoreticalReturn:6,items:[{matchId:"周一001",officialMatchId:"same-id",matchDate:"2026-09-08",kickoffAt:"2026-09-08T20:00:00+08:00",matchStatus:"Finished",market:"halfFull",pick:"胜胜",odd:3}]};
 const wrongDate={id:"周一001",matchId:"same-id",date:"2026-09-07",fullScore:"2:0",halfScore:"1:0",status:"settled"};
 assert.equal(settlePurchasePlan(plan,[wrongDate],{now:Date.parse("2026-09-09T00:00:00+08:00")}).status,"awaiting_result");
 const missingHalf={id:"周一001",matchId:"same-id",date:"2026-09-08",fullScore:"2:0",halfScore:"",status:"settled"},pending=settlePurchasePlan(plan,[missingHalf]);
 assert.equal(pending.status,"field_pending");assert.equal(pending.items[0].result,"字段待补");assert.equal(pending.items[0].finalScore,"2:0");
 const settled=settlePurchasePlan(plan,[{...missingHalf,halfScore:"1:0"}]);assert.equal(settled.status,"won");assert.equal(settled.simulatedReturn,6);assert.equal(settled.items[0].finalScore,"2:0");
 const voided=settlePurchasePlan(plan,[{...missingHalf,status:"void",voidRule:"odds_one"}]);assert.equal(voided.status,"refunded");assert.equal(voided.simulatedReturn,2);assert.equal(voided.items[0].settlementState,"void_settled");
});

test("verified full-time scores settle total-goal tickets when the market field is absent",async()=>{
 const [results,day23,day24]=await Promise.all([
  readFile(new URL("../data/result-supplements/2026-09-23-24.json",import.meta.url),"utf8").then(JSON.parse),
  readFile(new URL("../data/purchase-plan-snapshots/2026-09-23_170427_99e3b35fe068.json",import.meta.url),"utf8").then(JSON.parse),
  readFile(new URL("../data/purchase-plan-snapshots/2026-09-24_170309_68e58cb0dda4.json",import.meta.url),"utf8").then(JSON.parse),
 ]);
 const settle=(snapshot,id)=>settlePurchasePlan(snapshot.planSet.plans.find(plan=>plan.id===id),results.results);
 const day23Double=settle(day23,"total-double-2");
 assert.equal(day23Double.status,"won");
 assert.deepEqual(day23Double.items.map(item=>item.actual),["3球","2球"]);
 assert.equal(settle(day23,"total-single-2").status,"lost");
 const day24Triple=settle(day24,"total-double-3");
 assert.equal(day24Triple.status,"lost");
 assert.deepEqual(day24Triple.items.map(item=>item.actual),["3球","1球","3球"]);
 assert.ok(day24Triple.items.every(item=>item.settlementState==="settled"));
 const item={matchId:"周一001",officialMatchId:"high",matchDate:"2026-09-28",market:"total",pick:"7+球",odd:5};
 const plan={id:"high",status:"pending",items:[item]};
 assert.equal(settlePurchasePlan(plan,[{matchId:"high",date:"2026-09-28",fullScore:"4:3",status:"settled"}]).status,"won");
 assert.equal(settlePurchasePlan(plan,[{matchId:"high",date:"2026-09-28",totalGoalsResult:"7",fullScore:"4:3",status:"settled"}]).items[0].actual,"7+球");
 assert.equal(settlePurchasePlan(plan,[{matchId:"high",date:"2026-09-28",fullScore:"unknown",status:"settled"}]).status,"field_pending");
});

test("invalid or expired kickoff data cannot enter purchase plans",()=>{
 const report={id:"周一001",officialMatchId:"m1",officialMappingStatus:"verified",salesDate:"2026-09-08",matchDate:"2026-09-08",sourceFetchedAt:"2026-09-08T16:55:00+08:00",league:"测试",home:"甲",away:"乙",hadProbabilities:[{score:"胜",probability:70}]};
 const eligibility={"胜平负":{marketCode:"HAD",salesStatus:"Selling",qualification:"qualified",allowedPassCounts:[1],cutoffAt:"2026-09-08T19:50:00+08:00"}},base={officialMatchId:"m1",salesDate:"2026-09-08",matchStatus:"Selling",marketOdds:{"胜平负":[2.1,3,4]},marketEligibility:eligibility};
 for(const kickoffAt of ["18:00:00","2026-09-08T16:00:00+08:00"]){const set=generatePurchasePlans({date:"2026-09-08",reports:[report],officialMatches:[{...base,kickoffAt}],generatedAt:"2026-09-08T17:00:00+08:00"});assert.ok(set.plans.every(plan=>plan.status==="unavailable"))}
});

test("17:00 snapshot persists purchase drafts and the recommendation page exposes settlement",async()=>{
 const [capture,purchaseCapture,api,component,styles,sync]=await Promise.all([
  readFile(new URL("../scripts/capture-prediction-snapshot.mjs",import.meta.url),"utf8"),
  readFile(new URL("../scripts/capture-purchase-plan-snapshot.mjs",import.meta.url),"utf8"),
  readFile(new URL("../app/api/prediction-snapshots/route.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/components/TodayRecommendations.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/reference-ui.css",import.meta.url),"utf8"),
  readFile(new URL("../scripts/sync-prediction-decision-index.mjs",import.meta.url),"utf8"),
 ]);
 assert.match(capture,/async function appendPurchasePlans\(\)\{return null;\}/);
 assert.doesNotMatch(capture,/generatePurchasePlans/);
 assert.match(purchaseCapture,/generatePurchasePlans/);
 assert.match(purchaseCapture,/verifyPurchasePlanCompletion/);
 assert.match(purchaseCapture,/priorPlans:slot==="2100"\?earlier\.plans:\[\]/);
 assert.match(api,/purchasePlans:plan\?\.plans\|\|raw\.purchasePlans/);
 assert.match(component,/每日固定组合票/);
 assert.match(component,/17:00 场次/);
 assert.match(component,/21:00 场次/);
 assert.match(component,/const slotSets=useMemo\(\(\)=>planSets\.filter\(item=>purchaseSlot\(item\)===activeSlot\)/);
 assert.match(purchaseCapture,/--slot=2100/);
 assert.match(purchaseCapture,/record\.scheduledAt===`\$\{date\}T\$\{slotTime\}:00\+08:00`/);
 assert.match(purchaseCapture,/planSet\.scheduledTime=slotTime/);
 assert.match(component,/已归档方案必须按生成时赔率原样读取/);
 assert.doesNotMatch(component,/高覆盖门槛更新后按当前盘口重新试算/);
 assert.match(component,/settlePurchasePlan/);
 assert.match(component,/每注2元/);
 assert.match(component,/prediction-snapshots\?view=recommendations/);
 assert.match(component,/fetchHistoricalPurchaseResults\(formalSets,cachedResults,frozenProbabilitySnapshots\)/);
 assert.match(component,/promoteSavedPurchaseTrial/);
 assert.match(component,/赛果查询失败，相关组合暂不计入已结算/);
 assert.match(component,/purchase-plan-module/);
 assert.match(component,/collapsedModules/);
 assert.match(component,/aria-expanded/);
 assert.match(component,/aria-controls/);
 assert.match(component,/中奖 \/ 已结算/);
 assert.match(component,/投入 \/ 返还/);
 assert.match(component,/模型预期返奖/);
 assert.match(component,/命中时最低 \/ 最高盈利/);
 assert.match(component,/最近正式快照/);
 assert.match(component,/刷新快照/);
 assert.match(component,/visibilitychange/);
 assert.match(purchaseCapture,/record\.immutable===true&&record\.scheduledAt===/);
 assert.match(component,/最终赛果 \{purchaseHistoryActual\(item\)\} · 购入赔率 \{purchaseHistoryOdds\(item\)\}/);
 assert.match(component,/<details className="purchase-history-panel"/);
 assert.match(component,/allModulesCollapsed\?"全部展开":"全部收起"/);
 assert.match(component,/purchase-money-negative/);
 assert.match(component,/purchase-money-positive/);
 assert.match(styles,/purchase-history-panel>summary/);
 assert.match(styles,/\.daily-purchase-panel \.purchase-money-negative\{color:#168052/);
 assert.match(styles,/\.daily-purchase-panel \.purchase-money-positive\{color:#c34242/);
 assert.match(api,/generated-prediction-snapshot-index\.json/);
 assert.doesNotMatch(api,/prediction-snapshots\/\*\.json/);
 assert.match(sync,/bundlePath/);
 assert.match(styles,/purchase-plan-grid/);
 assert.match(styles,/purchase-module-stats/);
 assert.match(styles,/purchase-module-toggle/);
 assert.match(styles,/purchase-plan-grid\[hidden\]/);
});

test("bundled Site history includes the verified localhost migration without changing formal evaluation grain",async()=>{
 const [migration,bundle,api,archive,sync,audit]=await Promise.all([
  readFile(new URL("../data/migrated-browser-prediction-snapshots.json",import.meta.url),"utf8").then(JSON.parse),
  readFile(new URL("../data/generated-prediction-snapshot-index.json",import.meta.url),"utf8").then(JSON.parse),
  readFile(new URL("../app/api/prediction-snapshots/route.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/components/PredictionArchive.tsx",import.meta.url),"utf8"),
  readFile(new URL("../scripts/sync-prediction-decision-index.mjs",import.meta.url),"utf8"),
  readFile(new URL("../data/analysis/prediction-history-audit.json",import.meta.url),"utf8").then(JSON.parse),
 ]);
 assert.equal(migration.snapshotCount,13);
 assert.equal(migration.matchCount,150);
 assert.ok(migration.snapshots.every(snapshot=>snapshot.storageOrigin==="migrated-browser"&&snapshot.matches.every(match=>match.isMock!==true)));
 assert.equal(bundle.migratedSnapshotCount,migration.snapshotCount);
 assert.equal(bundle.snapshots.filter(snapshot=>snapshot.storageOrigin==="migrated-browser").reduce((sum,snapshot)=>sum+snapshot.matches.length,0),migration.matchCount);
 assert.equal(bundle.snapshots.reduce((sum,snapshot)=>sum+snapshot.matches.length,0),bundle.snapshots.filter(snapshot=>snapshot.storageOrigin==="server").reduce((sum,snapshot)=>sum+snapshot.matches.length,0)+migration.matchCount);
 assert.ok(Object.keys(bundle.resultCache||{}).length>=migration.resultCount);
 assert.ok(bundle.purchasePlanSnapshots.length>=50);
 assert.ok(bundle.purchasePlanSnapshots.some(snapshot=>snapshot.planSet?.date==="2026-09-25"),"17:00 正式组合票必须进入线上索引");
 assert.match(sync,/diskPurchaseSnapshots\.push/);
 assert.equal(audit.inventory.uniqueSettledMatches,55);
 assert.match(api,/bundledMigratedSnapshots/);
 assert.match(api,/verifiedResultCache/);
 assert.match(archive,/setResultCache\(\{\.\.\.remote\.resultCache,\.\.\.localResults,\.\.\.remote\.resultCorrections\}\)/);
 assert.match(sync,/formalSourceSnapshots/);
 assert.match(sync,/storageOrigin==="server"/);
 assert.match(sync,/allowedPredictionIds\.has/);
});

test("September 23 and 24 recovery keeps provenance and never invents full forecasts",async()=>{
 const [bundle,results]=await Promise.all([
  readFile(new URL("../data/generated-prediction-snapshot-index.json",import.meta.url),"utf8").then(JSON.parse),
  readFile(new URL("../data/result-supplements/2026-09-23-24.json",import.meta.url),"utf8").then(JSON.parse),
 ]);
 const recovered=buildArchiveRecoverySnapshots(bundle.snapshots,bundle.purchasePlanSnapshots);
 const day23=recovered.find(snapshot=>snapshot.date==="2026-09-23");
 const day24=recovered.find(snapshot=>snapshot.date==="2026-09-24");
 assert.deepEqual(day23.matches.map(match=>match.id),["周三001","周三002","周三003"]);
 assert.deepEqual(day23.matches.map(match=>match.archiveEvidence),["browser_cache","browser_cache","formal"]);
 assert.deepEqual(day24.matches.map(match=>match.id),Array.from({length:8},(_,index)=>`周四${String(index+1).padStart(3,"0")}`));
 assert.ok(day24.matches.every(match=>match.archiveEvidence==="purchase_plan_partial"&&match.purchasePicks.length&&!match.hadProbabilities&&!match.combinedScores));
 assert.equal(results.results.length,11);
 assert.equal(new Set(results.results.map(result=>result.matchId)).size,11);
 assert.ok(results.results.every(result=>/^\d+:\d+$/.test(result.fullScore)&&/^\d+:\d+$/.test(result.halfScore)));
 cloudReadTypes.length=0;
 const response=await render("/api/prediction-snapshots");
 assert.equal(response.status,200);
 const payload=await response.json();
 assert.equal(payload.cloudCaptureStatus,"available");
 assert.equal(payload.cloudError,null);
 assert.deepEqual(cloudReadTypes,["raw","purchase","source-attempt"]);
 assert.equal(payload.snapshots.find(snapshot=>snapshot.snapshotId==="2026-09-23-recovered-review-v1")?.matches.length,3);
 assert.equal(payload.snapshots.find(snapshot=>snapshot.snapshotId==="2026-09-24-recovered-review-v1")?.matches.length,8);
 assert.equal(Object.keys(payload.resultCorrections).length,11);
 assert.equal(payload.resultCorrections["official|2041646"].totalGoalsResult,"3");
 assert.equal(payload.resultCorrections["official|2041646"].totalGoalsResultBasis,"derived_from_verified_full_score");
 assert.equal(payload.resultCorrections["official|2041650"].totalGoalsResult,"1");
});

test("one immutable prediction version supplies prediction, recommendation and archive probabilities",async()=>{
 const [versionService,predictions,ai,page,recommendations,archive,capture]=await Promise.all([
  readFile(new URL("../app/prediction-version.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/api/predictions/route.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/api/predictions/ai/route.ts",import.meta.url),"utf8"),
  readWorkspaceSource(),
  readFile(new URL("../app/components/TodayRecommendations.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/components/PredictionArchive.tsx",import.meta.url),"utf8"),
  readFile(new URL("../scripts/capture-prediction-snapshot.mjs",import.meta.url),"utf8"),
 ]);
 assert.match(versionService,/if\(weight<=0\)return base/);
 assert.match(versionService,/validEvidenceRecords/);
 assert.match(versionService,/fullScoreDistribution/);
 assert.match(predictions,/createBasePredictionVersion/);
 assert.match(ai,/body\.version/);
 assert.match(versionService,/reviewForPredictionId:baseVersion\.predictionId/);
 assert.doesNotMatch(page,/previous\?\.combinedScores/);
 assert.doesNotMatch(recommendations,/value\.odds\*MODEL_WEIGHTS/);
 assert.match(recommendations,/不在本页重新融合/);
 assert.match(recommendations,/type RecommendationMarket/);
 assert.match(await readFile(new URL("../app/recommendation-returns.ts",import.meta.url),"utf8"),/type RecommendationMarket\s*=\s*keyof typeof MARKET_META/);
 assert.match(recommendations,/type="checkbox"/);
 assert.match(recommendations,/半全场/);
 assert.match(recommendations,/new Set\(items\.map/);
 assert.match(recommendations,/total:\s*"总进球数"/);
 assert.match(recommendations,/match\.totalGoalProbabilities/);
 assert.match(recommendations,/marketEligibilityNames/);
 assert.match(recommendations,/total:\s*"总进球数"/);
 assert.match(recommendations,/halfFull:\s*"半全场"/);
 assert.match(recommendations,/推荐彩票日期/);
 assert.match(recommendations,/matchDateKey\(match,\s*current\)/);
 assert.match(recommendations,/全部彩票日期/);
 assert.match(recommendations,/按竞彩编号所属销售日筛选/);
 assert.match(recommendations,/lotteryDate=\{effectiveMatchDate\}/);
 assert.match(recommendations,/match\.salesDate \|\| match\.matchDate \|\| match\.kickoffAt/);
 assert.match(recommendations,/current\?\.salesDate/);
 assert.match(page,/竞彩开售日/);
 assert.match(page,/match\.salesDate \|\| match\.matchDate/);
 assert.match(archive,/预测版本 \{selected\.predictionId\}/);
 assert.match(capture,/body: JSON\.stringify\(\{ version: raw\.version, reports: raw\.reports \}\)/);
});

test("pre-match snapshots are append-only and keep prediction layers separate",async()=>{
 const [capture,purchaseCapture,api,page,recommendations,storage]=await Promise.all([
  readFile(new URL("../scripts/capture-prediction-snapshot.mjs",import.meta.url),"utf8"),
  readFile(new URL("../scripts/capture-purchase-plan-snapshot.mjs",import.meta.url),"utf8"),
  readFile(new URL("../app/api/prediction-snapshots/route.ts",import.meta.url),"utf8"),
  readWorkspaceSource(),
  readFile(new URL("../app/components/TodayRecommendations.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/browser-storage.ts",import.meta.url),"utf8"),
 ]);
 assert.match(capture,/flag: "wx"/);
 assert.match(capture,/recordType: "raw-prediction-snapshot"/);
 assert.match(capture,/\.supplement\.ai\./);
 assert.doesNotMatch(capture,/\.supplement\.plans\./);
 assert.match(purchaseCapture,/recordType:"purchase-plan-snapshot"/);
 assert.match(purchaseCapture,/flag:"wx"/);
 assert.match(purchaseCapture,/const verifiedOfficialMatches=resolveServerOfficialMatches\(predictionData,matches,date\)/);
 assert.match(purchaseCapture,/officialMatches:verifiedOfficialMatches/);
 assert.match(purchaseCapture,/verifyPurchasePlanCompletion\(planSet,verifiedOfficialMatches,capturedAt\)/);
 assert.match(capture,/scheduledAt/);
 assert.match(capture,/upstreamUpdatedAt/);
 assert.match(capture,/aiCompletedAt/);
 assert.match(capture,/oddsBaseline/);
 assert.match(capture,/intelligenceOutput/);
 assert.match(capture,/fusionOutput/);
 assert.match(api,/snapshotOddsProjection\(report\)/);
 assert.match(api,/report\.layers\?\.intelligenceOutput\?\.scores\|\|report\.intelligenceScores\|\|\[\]/);
 assert.match(api,/report\.layers\?\.fusionOutput\?\.fullScoreDistribution\|\|report\.fullScoreDistribution/);
 assert.doesNotMatch(api,/oddsScores:\(report\.scores\|\|\[\]\)/);
 assert.match(page,/void savePredictionSet\(saved\)/);
 assert.match(storage,/if\(history\.some\(item=>item\.historyRecordId===saved\.historyRecordId\)\)return history/);
 assert.match(storage,/\.\.\.history/);
 assert.doesNotMatch(recommendations,/高覆盖门槛更新后按当前盘口重新试算/);
});

test("AI numerical fusion is gated by out-of-sample gain while shadow probabilities are retained",async()=>{
 const source=await readFile(new URL("../app/prediction-version.ts",import.meta.url),"utf8");
 const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const {applyAiReviewVersion}=await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
 const generatedAt="2026-09-12T12:00:00.000Z",baseVersion={predictionId:"pred-base",inputSnapshotId:"input-1",baseModelVersion:"base",calibrationVersion:"cal-none",generatedAt};
 const report={id:"周六001",kickoffAt:"2026-09-12T22:00:00+08:00",predictionId:"pred-base",fullScoreDistribution:[{score:"1:0",probability:50},{score:"0:1",probability:50}],scores:[{score:"1:0",probability:50},{score:"0:1",probability:50}],marketSignal:{officialHandicap:"0"},intelligenceEvidence:{records:[{type:"lineup",sourceUrl:"https://example.com/evidence",observedAt:"2026-09-12T11:00:00.000Z"}]}};
 const review={id:"周六001",scores:[{score:"1:0",probability:90},{score:"0:1",probability:10}],verifiedIntelItems:["lineup"],summary:"证据复核",risk:""};
 const shadowOnly=applyAiReviewVersion(baseVersion,[report],[review],"DeepSeek","test",generatedAt,0);
 assert.equal(shadowOnly.version.predictionId,"pred-base");
 assert.equal(shadowOnly.reports[0].appliedIntelligenceWeight,0);
 assert.equal(shadowOnly.reports[0].fullScoreDistribution[0].probability,50);
 assert.ok(shadowOnly.reports[0].shadowFullScoreDistribution[0].probability>50);
 const validated=applyAiReviewVersion(baseVersion,[report],[review],"DeepSeek","test",generatedAt,1);
 assert.notEqual(validated.version.predictionId,"pred-base");
 assert.ok(validated.reports[0].appliedIntelligenceWeight>0);
 assert.ok(validated.reports[0].fullScoreDistribution[0].probability>50);
});

test("model audit surface exposes historical baseline comparison and guarded improvements",async()=>{
 const [api,panel,model,archive,aiRoute]=await Promise.all([
  readFile(new URL("../app/api/model-audit/route.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/components/ModelHealthPanel.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/api/predictions/route.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/components/PredictionArchive.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/api/predictions/ai/route.ts",import.meta.url),"utf8"),
 ]);
 assert.match(api,/prediction-history-audit\.json/);
 assert.match(panel,/模型与数据健康/);
 assert.match(panel,/旧口径未保证同场配对，不能据此判断领先/);
 assert.doesNotMatch(panel,/marketLead|模型暂未超越基线/);
 assert.match(panel,/AI 文字复核不改动正式概率/);
 assert.match(panel,/AI 正式概率权重/);
 assert.match(panel,/<b>0% · 仅文字复核<\/b>/);
 assert.match(model,/predictFromSnapshot/);
 assert.match(model,/低比分修正处于影子验证/);
 assert.match(model,/return submitPredictionRequest\(request\)/);
 assert.match(await readFile(new URL("../app/prediction-submission.js",import.meta.url),"utf8"),/fixtureIds\.length > 120/);
 assert.match(model,/await fetchOfficialSporttery\(\{\s*repair:\s*forceRefresh,\s*serverHeaders:\s*true\s*\}\)/);
 assert.match(model,/unavailableOfficialMatches/);
 assert.match(model,/覆盖 \$\{coverage\.predictedMatches\}\/\$\{coverage\.officialMatches\} 场官方赛事/);
 assert.match(archive,/match\.officialMatchId&&result\.matchId/);
 assert.match(archive,/intelligenceCandidateProbabilities/);
 assert.match(aiRoute,/resolveContextEvidence/);
 assert.match(aiRoute,/validateEvidenceReviews/);
 assert.match(aiRoute,/applyEvidenceReviews/);
 assert.match(aiRoute,/reviewMode:"evidence-summary-v1"/);
 assert.match(aiRoute,/intelligenceWeightMultiplier:0/);
 assert.doesNotMatch(aiRoute,/applyAiReviewVersion/);
 assert.match(aiRoute,/body\.reports\.length>120/);
});
