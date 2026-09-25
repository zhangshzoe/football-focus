import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {generatePurchasePlans,PURCHASE_PLAN_MODULES,settlePurchasePlan,summarizePurchasePlanModules,summarizePurchasePlanDefinitions} from "../app/purchase-plan-engine.js";
import {teamIdentity} from "../app/team-identity.js";
import {decisionTargetAt,selectOfficialDecisionRows} from "../app/snapshot-decision-policy.js";
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
 assert.equal(delayedScheduled.length,1);assert.equal(delayedScheduled[0].snapshot.snapshotId,"scheduled");
});

test("legacy and immutable raw snapshot filenames share the same online index identity",()=>{
 assert.equal(snapshotIdFromFileName("2026-09-07_2000.json"),"2026-09-07-2000");
 assert.equal(snapshotIdFromFileName("2026-09-22_2130.raw.json"),"2026-09-22-2130");
 assert.equal(snapshotIdFromFileName("2026-09-22_2130.supplement.ai.json"),"");
});

async function render(path="/"){
 const workerUrl=new URL("../dist/server/index.js",import.meta.url);
 workerUrl.searchParams.set("test",`${process.pid}-${Date.now()}-${path}`);
 const {default:worker}=await import(workerUrl.href);
 return worker.fetch(new Request(`http://localhost${path}`,{headers:{accept:"text/html"}}),{ASSETS:{fetch:async()=>new Response("Not found",{status:404})}},{waitUntil(){},passThroughOnException(){}});
}

async function loadSportteryRoute(){
 const sharedSource=await readFile(new URL("../app/sporttery-official.ts",import.meta.url),"utf8"),sharedJavascript=ts.transpileModule(sharedSource,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,sharedUrl=`data:text/javascript;base64,${Buffer.from(sharedJavascript).toString("base64")}#${Date.now()}-${Math.random()}`;
 const source=(await readFile(new URL("../app/api/sporttery/route.ts",import.meta.url),"utf8")).replace('import {NextResponse} from "next/server";','const NextResponse={json:(body,init={})=>new Response(JSON.stringify(body),{...init,headers:{"Content-Type":"application/json",...(init.headers||{})}})};').replace('from "../../sporttery-official"',`from "${sharedUrl}"`);
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

  globalThis.fetch=async()=>new Response("blocked",{status:567});
  response=await get();data=await response.json();
  assert.equal(response.status,502);assert.match(data.error,/567（官方站点防护拦截/);
 }finally{globalThis.fetch=originalFetch}
});

test("mobile prediction summaries and wide forecast tables support consistent horizontal swiping",async()=>{
 const [report,table,styles]=await Promise.all([
  readFile(new URL("../app/components/AiPredictionReport.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/components/MarketPredictionTable.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/reference-ui.css",import.meta.url),"utf8"),
 ]);
 assert.match(report,/左右滑动查看 5 类预测/);
 assert.match(report,/role="region"/);
 assert.match(table,/左右滑动查看完整预测数据/);
 assert.match(styles,/\.prediction-overview-grid\{display:flex!important/);
 assert.match(styles,/scroll-snap-type:x mandatory/);
 assert.match(styles,/touch-action:pan-x pan-y/);
 assert.match(styles,/\.market-forecast-table th:nth-child\(9\).*width:230px!important/);
});

test("mobile prediction fallback derives a traceable baseline only from official markets",async()=>{
 const source=await readFile(new URL("../app/official-prediction-fallback.ts",import.meta.url),"utf8"),javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText,{buildOfficialPredictionFallback}=await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}#${Date.now()}-${Math.random()}`);
 const match={id:"周六001",matchId:"m1",officialMatchId:"m1",salesDate:"2026-09-19",matchDate:"2026-09-19",time:"20:00:00",home:"主队",away:"客队",league:"测试联赛",handicap:"-1",marketEligibility:{"让球胜平负":{qualification:"qualified"}},marketOdds:{"胜平负":[2.1,3.2,3.4],"让球胜平负":[3.1,3.4,1.9],"比分":[7.2],"总进球数":[20,8,3.3,3.2,5,10,18,25],"半全场":[3,12,30,5,6,10,20,11,8]}};
 const fallback=buildOfficialPredictionFallback([match],"2026-09-19T05:00:00.000Z"),report=fallback.reports[0];
 assert.equal(fallback.reports.length,1);assert.match(fallback.version.predictionId,/^official-browser-/);assert.equal(report.companies.length,0);assert.equal(report.marketSignal.hhadAvailable,true);assert.equal(report.marketSignal.officialHandicap,"-1");assert.equal(report.marketSignal.officialOdds[0],2.1);assert.ok(report.scores.length>0);assert.ok(Math.abs(report.marketProbabilities.reduce((sum,value)=>sum+value,0)-100)<0.001);
});

test("production match board has explicit official-data states and no demo fallback",async()=>{
 const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
 assert.match(page,/type DataState="loading"\|"success"\|"stale"\|"empty"\|"error"/);
 assert.match(page,/const allMatches=useMemo\(\(\)=>liveMatches\.slice\(\)\.sort\(compareMatchesByDateAndSequence\)/);
 assert.match(page,/const compareMatchesByDateAndSequence=/);
 assert.match(page,/const oddsFor=.*return null/);
 assert.match(page,/暂未开售或暂无官方赔率/);
 assert.match(page,/全部赔率选择和新预测已暂停/);
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
 assert.ok(high.improvementAreas.includes("总进球校准"));
 const low=buildPostMatchReview(base,{fullScore:"0:0",handicap:"-1"});
 assert.ok(low.causeTags.includes("小球偏离"));
});

test("historical calibration is wired into predictions without treating missing fields as misses",async()=>{
 const [archive,engine,predictions,page,ai,calibration]=await Promise.all([
  readFile(new URL("../app/components/PredictionArchive.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/post-match-review.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/api/predictions/route.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/api/predictions/ai/route.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/calibration-service.ts",import.meta.url),"utf8"),
 ]);
 assert.match(archive,/probabilityTemperature/);
 assert.match(archive,/未参与调参的未来测试成绩/);
 assert.match(engine,/predictedGoalPoint&&!totalTopTwoMatched/);
 assert.match(engine,/actualHalfFull&&halfFull\.length&&!halfFullMatched/);
 assert.match(predictions,/temperatureCalibrate/);
 assert.match(predictions,/goalDispersion/);
 assert.doesNotMatch(page,/PREDICTION_CALIBRATION_STORAGE_KEY/);
 assert.match(predictions,/getPublishedCalibration/);
 assert.match(calibration,/decisionTargetAt/);
 assert.match(calibration,/latest_not_after_official_target_v1/);
 assert.match(calibration,/selected\.slice\(0,\s*trainEnd\)/);
 assert.match(calibration,/selected\.slice\(trainEnd,\s*calibrationEnd\)/);
 assert.match(calibration,/selected\.slice\(calibrationEnd\)/);
 assert.match(calibration,/futureTest:\s*\{\s*raw:\s*testRaw,\s*calibrated:\s*testCalibrated,\s*marketBaseline:\s*testMarket/s);
  assert.match(calibration,/promotionCandidate:\s*evaluation\.status\s*===\s*"validated"/);
  assert.match(calibration,/未来独立样本 ≥ 100/);
  assert.doesNotMatch(calibration,/flag:"wx"/);
 assert.match(ai,/intelligenceCoverage/);
 assert.match(ai,/只有盘口、没有独立赛前情报时必须返回0/);
});

test("small independent calibration samples keep temperature at one",async()=>{
 const policyUrl=new URL("../app/snapshot-decision-policy.js",import.meta.url).href;
 const source=(await readFile(new URL("../app/calibration-service.ts",import.meta.url),"utf8"))
  .replace('from "./snapshot-decision-policy.js"',`from "${policyUrl}"`)
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
 assert.match(archive,/if\(!unique\.has\(key\)\)unique\.set/);
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
 assert.match(table,/前2<br\/>概率和/);
 assert.match(table,/goalCoverage>50\?"goal-top2"/);
 assert.match(table,/rank===0\?"goal-prob-first":rank===1\?"goal-prob-second"/);
 assert.match(table,/goalPicks\.map\(item=>item\.label\)\.join\(" \/ "\)/);
 assert.match(table,/SCORE_TOP_TWO_COVERAGE_THRESHOLD=25/);
 assert.match(table,/SCORE_SINGLE_PROBABILITY_THRESHOLD=15/);
 assert.match(table,/scoreTopTwoCoverage>SCORE_TOP_TWO_COVERAGE_THRESHOLD\?"score-coverage-high"/);
 assert.match(table,/item\?\.probability\|\|0\)>SCORE_SINGLE_PROBABILITY_THRESHOLD/);
 assert.match(styles,/forecast-expectation\.expanded>span[^]*-webkit-line-clamp:unset!important/);
 assert.match(styles,/forecast-view-score td\.forecast-expectation\{text-align:left!important\}/);
});

test("daily purchase drafts generate all fixed traceable ticket types and settle alternatives",()=>{
 const reports=Array.from({length:8},(_,index)=>({id:`周一00${index+1}`,officialMatchId:`official-${index+1}`,officialMappingStatus:"verified",salesDate:"2026-09-08",matchDate:"2026-09-08",kickoffAt:"2026-09-08T20:00:00+08:00",sourceFetchedAt:"2026-09-08T16:55:00+08:00",league:"测试联赛",home:`主队${index+1}`,away:`客队${index+1}`,matchStatus:"Selling",isMock:false,handicap:"-1",hadProbabilities:[{score:"胜",probability:70-index*.2},{score:"平",probability:16},{score:"负",probability:14+index*.2}],hhadProbabilities:[{score:"让胜",probability:48},{score:"让平",probability:30},{score:"让负",probability:22}],combinedScores:[{score:"1:0",probability:20},{score:"2:0",probability:15}],totalGoalProbabilities:[{score:"2球",probability:28},{score:"3球",probability:25}],halfFullProbabilities:[{score:"胜胜",probability:36},{score:"平胜",probability:24},{score:"平平",probability:14}]}));
 const qualified=(marketCode,handicap)=>({marketCode,salesStatus:"Selling",qualification:"qualified",handicap,allowedPassCounts:[1,2,3,4,5,6,7,8],cutoffAt:"2026-09-08T19:50:00+08:00",ruleVersion:"test"});
 const officialMatches=reports.map(report=>({id:report.id,officialMatchId:report.officialMatchId,salesDate:report.salesDate,matchDate:report.matchDate,kickoffAt:report.kickoffAt,matchStatus:"Selling",marketOdds:{"胜平负":[2.1,3.2,4],"让球胜平负":[3.1,3.4,1.9],"比分":Array(31).fill(9),"总进球数":[12,6,3.5,3.2,5,8,12,16],"半全场":[4,12,25,5,6,14,18,13,7]},marketEligibility:{"胜平负":qualified("HAD"),"让球胜平负":qualified("HHAD","-1"),"比分":qualified("CRS"),"总进球数":qualified("TTG"),"半全场":qualified("HAFU")}}));
 const set=generatePurchasePlans({date:"2026-09-08",reports,officialMatches,generatedAt:"2026-09-08T09:00:00.000Z"});
 assert.equal(set.plans.length,18);assert.deepEqual(set.plans.map(plan=>plan.id),["score-double-3","score-single-2","score-double-2","score-single-3","total-double-3","total-double-2","total-single-2","draw-or-handicap-draw-2","draw-or-handicap-draw-3","result-mixed-3","result-mixed-4","result-mixed-5","had-safe-2","tenfold-safe-2","tenfold-safe-3","tenfold-safe-4","total-adjacent-double-2","half-full-double-3"]);
 assert.equal(set.plans[0].betCount,8);assert.equal(set.plans[0].stake,16);assert.equal(set.plans[1].betCount,1);assert.equal(set.plans[1].stake,2);assert.equal(set.plans[2].betCount,4);assert.equal(set.plans[4].betCount,8);assert.equal(set.plans[5].betCount,4);assert.equal(set.plans[5].stake,8);assert.equal(set.plans[6].betCount,1);
 assert.ok(set.plans[5].items.every(item=>item.market==="total"&&item.picks.length===2));
 assert.ok(set.plans[7].items.every(item=>item.pick==="平"||item.pick==="让平"));
 assert.ok(set.plans[8].items.every(item=>item.pick==="平"||item.pick==="让平"));
 assert.ok(set.plans[12].items.every(item=>item.probability>=50));
 assert.ok(!set.plans.some(plan=>plan.id==="had-double-2"));
 for(const [index,matches] of [[13,2],[14,3],[15,4]]){assert.equal(set.plans[index].items.length,matches);assert.equal(set.plans[index].stake,2);assert.equal(set.plans[index].betCount,1);assert.ok(set.plans[index].minWinningProfit>0);assert.ok(set.plans[index].items.every(item=>item.probability>=30&&item.picks.length===1))}
 assert.ok(set.plans[16].items.every(item=>Math.abs(Number(item.picks[0].pick.match(/\d+/)?.[0])-Number(item.picks[1].pick.match(/\d+/)?.[0]))===1));
 assert.equal(set.plans[17].passName,"3串1");assert.equal(set.plans[17].betCount,8);assert.equal(set.plans[17].stake,16);assert.ok(set.plans[17].minWinningProfit>0);
 assert.ok(set.plans[17].items.every(item=>item.market==="halfFull"&&item.picks.length===2));
 for(const plan of set.plans){assert.equal(plan.status,"pending");assert.equal(new Set(plan.items.map(item=>item.matchId)).size,plan.items.length);assert.ok(plan.maxWinningReturn>=plan.minWinningReturn)}
 const first=set.plans[0],results=first.items.map(item=>({id:item.matchId,matchId:item.officialMatchId,date:"2026-09-08",fullScore:"2:0",scoreResult:"2:0",status:"settled"}));
 assert.equal(settlePurchasePlan(first,results).status,"won");
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
 assert.deepEqual(PURCHASE_PLAN_MODULES.map(module=>module.id),["score","total","result","draw","halfFull","tenfold"]);
 const summary=summarizePurchasePlanModules([{plans:[
  {id:"score-double-3",status:"won",stake:16,simulatedReturn:90},
  {id:"score-single-2",status:"lost",stake:2,simulatedReturn:0},
  {id:"total-double-2",status:"pending",stake:8,simulatedReturn:0},
  {id:"result-mixed-3",status:"void_lost",stake:2,simulatedReturn:0},
  {id:"draw-or-handicap-draw-2",status:"corrected_won",stake:2,simulatedReturn:12},
  {id:"half-full-double-3",status:"field_pending",stake:16,simulatedReturn:0},
  {id:"tenfold-safe-2",status:"corrected_won",stake:2,simulatedReturn:22},
 ]}]);
 assert.deepEqual(summary.score,{settled:2,won:1,rate:50,stake:18,returned:90,net:72});
 assert.deepEqual(summary.total,{settled:0,won:0,rate:0,stake:0,returned:0,net:0});
 assert.deepEqual(summary.result,{settled:1,won:0,rate:0,stake:2,returned:0,net:-2});
 assert.deepEqual(summary.draw,{settled:1,won:1,rate:100,stake:2,returned:12,net:10});
 assert.deepEqual(summary.halfFull,{settled:0,won:0,rate:0,stake:0,returned:0,net:0});
 assert.deepEqual(summary.tenfold,{settled:1,won:1,rate:100,stake:2,returned:22,net:20});
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

test("settlement keeps missing fields pending and isolates official ids by date",()=>{
 const plan={id:"p",status:"pending",stake:2,theoreticalReturn:6,items:[{matchId:"周一001",officialMatchId:"same-id",matchDate:"2026-09-08",kickoffAt:"2026-09-08T20:00:00+08:00",matchStatus:"Finished",market:"halfFull",pick:"胜胜",odd:3}]};
 const wrongDate={id:"周一001",matchId:"same-id",date:"2026-09-07",fullScore:"2:0",halfScore:"1:0",status:"settled"};
 assert.equal(settlePurchasePlan(plan,[wrongDate],{now:Date.parse("2026-09-09T00:00:00+08:00")}).status,"awaiting_result");
 const missingHalf={id:"周一001",matchId:"same-id",date:"2026-09-08",fullScore:"2:0",halfScore:"",status:"settled"},pending=settlePurchasePlan(plan,[missingHalf]);
 assert.equal(pending.status,"field_pending");assert.equal(pending.items[0].result,"字段待补");
 const settled=settlePurchasePlan(plan,[{...missingHalf,halfScore:"1:0"}]);assert.equal(settled.status,"won");assert.equal(settled.simulatedReturn,6);
 const voided=settlePurchasePlan(plan,[{...missingHalf,status:"void",voidRule:"odds_one"}]);assert.equal(voided.status,"void_won");assert.equal(voided.simulatedReturn,2);
});

test("invalid or expired kickoff data cannot enter purchase plans",()=>{
 const report={id:"周一001",officialMatchId:"m1",officialMappingStatus:"verified",salesDate:"2026-09-08",matchDate:"2026-09-08",sourceFetchedAt:"2026-09-08T16:55:00+08:00",league:"测试",home:"甲",away:"乙",hadProbabilities:[{score:"胜",probability:70}]};
 const eligibility={"胜平负":{marketCode:"HAD",salesStatus:"Selling",qualification:"qualified",allowedPassCounts:[1],cutoffAt:"2026-09-08T19:50:00+08:00"}},base={officialMatchId:"m1",salesDate:"2026-09-08",matchStatus:"Selling",marketOdds:{"胜平负":[2.1,3,4]},marketEligibility:eligibility};
 for(const kickoffAt of ["18:00:00","2026-09-08T16:00:00+08:00"]){const set=generatePurchasePlans({date:"2026-09-08",reports:[report],officialMatches:[{...base,kickoffAt}],generatedAt:"2026-09-08T17:00:00+08:00"});assert.ok(set.plans.every(plan=>plan.status==="unavailable"))}
});

test("17:00 snapshot persists purchase drafts and the recommendation page exposes settlement",async()=>{
 const [capture,api,component,styles,sync]=await Promise.all([
  readFile(new URL("../scripts/capture-prediction-snapshot.mjs",import.meta.url),"utf8"),
  readFile(new URL("../app/api/prediction-snapshots/route.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/components/TodayRecommendations.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/reference-ui.css",import.meta.url),"utf8"),
  readFile(new URL("../scripts/sync-prediction-decision-index.mjs",import.meta.url),"utf8"),
 ]);
 assert.match(capture,/slot !== "1700"/);
 assert.match(capture,/generatePurchasePlans/);
 assert.match(api,/purchasePlans:plan\?\.plans\|\|raw\.purchasePlans/);
 assert.match(component,/每日固定组合票/);
 assert.match(component,/已归档方案必须按生成时赔率原样读取/);
 assert.doesNotMatch(component,/高覆盖门槛更新后按当前盘口重新试算/);
 assert.match(component,/settlePurchasePlan/);
 assert.match(component,/每注2元/);
 assert.match(component,/prediction-snapshots\?view=recommendations/);
 assert.match(component,/purchase-plan-module/);
 assert.match(component,/collapsedModules/);
 assert.match(component,/aria-expanded/);
 assert.match(component,/aria-controls/);
 assert.match(component,/中奖 \/ 已结算/);
 assert.match(component,/投入 \/ 返还/);
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
 assert.equal(audit.inventory.uniqueSettledMatches,55);
 assert.match(api,/bundledMigratedSnapshots/);
 assert.match(api,/verifiedResultCache/);
 assert.match(archive,/setResultCache\(\{\.\.\.remote\.resultCache,\.\.\.localResults,\.\.\.remote\.resultCorrections\}\)/);
 assert.match(sync,/formalSourceSnapshots/);
 assert.match(sync,/storageOrigin!=="migrated-browser"/);
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
 const response=await render("/api/prediction-snapshots");
 assert.equal(response.status,200);
 const payload=await response.json();
 assert.equal(payload.snapshots.find(snapshot=>snapshot.snapshotId==="2026-09-23-recovered-review-v1")?.matches.length,3);
 assert.equal(payload.snapshots.find(snapshot=>snapshot.snapshotId==="2026-09-24-recovered-review-v1")?.matches.length,8);
 assert.equal(Object.keys(payload.resultCorrections).length,11);
});

test("one immutable prediction version supplies prediction, recommendation and archive probabilities",async()=>{
 const [versionService,predictions,ai,page,recommendations,archive,capture]=await Promise.all([
  readFile(new URL("../app/prediction-version.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/api/predictions/route.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/api/predictions/ai/route.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
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
 assert.match(page,/match\.salesDate\|\|match\.matchDate/);
 assert.match(archive,/预测版本 \{selected\.predictionId\}/);
 assert.match(capture,/body: JSON\.stringify\(\{ version: raw\.version, reports: raw\.reports \}\)/);
});

test("pre-match snapshots are append-only and keep prediction layers separate",async()=>{
 const [capture,api,page,recommendations,storage]=await Promise.all([
  readFile(new URL("../scripts/capture-prediction-snapshot.mjs",import.meta.url),"utf8"),
  readFile(new URL("../app/api/prediction-snapshots/route.ts",import.meta.url),"utf8"),
  readFile(new URL("../app/page.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/components/TodayRecommendations.tsx",import.meta.url),"utf8"),
  readFile(new URL("../app/browser-storage.ts",import.meta.url),"utf8"),
 ]);
 assert.match(capture,/flag: "wx"/);
 assert.match(capture,/recordType: "raw-prediction-snapshot"/);
 assert.match(capture,/\.supplement\.ai\./);
 assert.match(capture,/\.supplement\.plans\./);
 assert.match(capture,/officialMatches: raw\.officialMatches/);
 assert.match(capture,/scheduledAt/);
 assert.match(capture,/upstreamUpdatedAt/);
 assert.match(capture,/aiCompletedAt/);
 assert.match(capture,/oddsBaseline/);
 assert.match(capture,/intelligenceOutput/);
 assert.match(capture,/fusionOutput/);
 assert.match(api,/report\.layers\?\.oddsBaseline\?\.fullScoreDistribution\|\|report\.oddsScores\|\|\[\]/);
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
 const report={id:"周六001",predictionId:"pred-base",fullScoreDistribution:[{score:"1:0",probability:50},{score:"0:1",probability:50}],scores:[{score:"1:0",probability:50},{score:"0:1",probability:50}],marketSignal:{officialHandicap:"0"},intelligenceEvidence:{records:[{type:"lineup",sourceUrl:"https://example.com/evidence",observedAt:"2026-09-12T11:00:00.000Z"}]}};
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
 assert.match(panel,/模型暂未超越基线/);
 assert.match(panel,/AI 情报采用证据时效 \+ 未来增益双重门控/);
 assert.match(model,/dixonColesTau/);
 assert.match(model,/低比分修正处于影子验证/);
 assert.match(model,/input\.matches\.slice\(0, 120\)/);
 assert.match(model,/unavailableOfficialMatches/);
 assert.match(model,/覆盖 \$\{coverage\.predictedMatches\}\/\$\{coverage\.officialMatches\} 场官方赛事/);
 assert.match(archive,/match\.officialMatchId&&result\.matchId/);
 assert.match(archive,/intelligenceCandidateProbabilities/);
 assert.match(aiRoute,/official-team-form-and-ranking/);
 assert.match(aiRoute,/official-competition-context/);
 assert.match(aiRoute,/evidenceById/);
 assert.match(aiRoute,/getMatchHeadV1\.qry/);
 assert.match(aiRoute,/body\.reports\.length>120/);
});
