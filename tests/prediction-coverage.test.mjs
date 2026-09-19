import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import ts from "typescript";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {teamIdentity} from "../app/team-identity.js";

const compile=(source,fileName="test.ts")=>{
 const js=ts.transpileModule(source,{fileName,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 return `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
};

// Names and kickoff identities reproduce the 2026-09-14 feed mismatch.
// All odds below are synthetic fixtures, not saved betting or forecast data.
const fixtures=[
 ["002","国际图尔","瓦萨","图尔库国际","VPS瓦萨","芬超","2026-09-14 23:00:00"],
 ["003","科莫","帕尔马","科莫","帕尔马","意甲","2026-09-15 00:30:00"],
 ["004","都灵","罗马","都灵","罗马","意甲","2026-09-15 00:30:00"],
 ["005","佐加顿斯","盖斯","尤尔加登","哥德堡盖斯","瑞典超","2026-09-15 01:00:00"],
 ["006","博德闪耀","桑纳菲","博德闪耀","桑德菲杰","挪超","2026-09-15 01:00:00"],
 ["007","吉达国民","棉农","吉达国民","塔什干棉农","亚精英赛","2026-09-15 02:15:00"],
 ["008","国际米兰","乌迪内斯","国米","乌迪内斯","意甲","2026-09-15 02:45:00"],
 ["009","圣旺红星","梅斯","红星","梅斯","法乙","2026-09-15 02:45:00"],
 ["010","利兹联","纽卡斯尔","利兹联","纽卡斯尔联","英超","2026-09-15 03:00:00"],
 ["011","比利亚雷","贝蒂斯","比利亚雷亚尔","贝蒂斯","西甲","2026-09-15 03:00:00"],
 ["012","布拉加","埃斯托里","布拉加","埃斯托里尔","葡超","2026-09-15 03:45:00"],
 ["110","韦斯特罗","马尔默","瓦斯特拉斯","马尔默","瑞超","2026-09-19 21:00:00"],
 ["117","克里斯蒂","罗森博格","克里斯蒂安松","罗森博格","挪超","2026-09-19 22:00:00"],
 ["130","米拉索尔","博塔弗戈","米拉索","博塔弗戈","巴甲","2026-09-20 04:00:00"],
 ["014","中国女","中国港女","中国香港女足","中国女足","亚运女足","2026-09-14 18:00:00"],
];

test("confirmed aliases match in context without weakening team or home/away identity",()=>{
 for(const [,home,away,externalHome,externalAway,league] of fixtures.slice(0,-1)){
  assert.equal(teamIdentity(home,league),teamIdentity(externalHome,league));
  assert.equal(teamIdentity(away,league),teamIdentity(externalAway,league));
 }
 assert.notEqual(teamIdentity("红星"),teamIdentity("圣旺红星"));
 assert.notEqual(teamIdentity("红星","塞超"),teamIdentity("圣旺红星","法乙"));
 assert.notEqual(teamIdentity("国米"),teamIdentity("迈阿密国际"));
 assert.notEqual(teamIdentity("中国女"),teamIdentity("中国港女"));
 assert.notEqual(teamIdentity("曼联"),teamIdentity("曼城"));
  assert.notEqual(teamIdentity("米拉索"),teamIdentity("博塔弗戈"));
});

async function loadRoute(){
 const version=compile(await readFile(new URL("../app/prediction-version.ts",import.meta.url),"utf8"));
 const aliases=new URL("../app/team-identity.js",import.meta.url).href;
 const source=(await readFile(new URL("../app/api/predictions/route.ts",import.meta.url),"utf8"))
  .replace('from "../../prediction-version"',`from ${JSON.stringify(version)}`)
  .replace('import {getPublishedCalibration} from "../../calibration-service";','const getPublishedCalibration=async()=>null;')
  .replace('from "../../team-identity.js"',`from ${JSON.stringify(aliases)}`);
 return import(compile(source));
}

test("prediction API recovers every confirmed alias and explains the reversed fixture instead of dropping it",async()=>{
 const official=fixtures.map(([id,home,away,,,league,kickoff])=>({id:`周一${id}`,officialMatchId:`test-${id}`,salesDate:"2026-09-14",matchDate:kickoff.slice(0,10),time:kickoff.slice(11),kickoffAt:kickoff.replace(" ","T")+"+08:00",home,away,league,odds:[2.1,3.2,3.4],marketEligibility:{}}));
 const external=fixtures.map(([id,,,home,away,league,kickoff])=>({ID:`test-feed-${id}`,CC_ID:`周一${id}`,HOST_NAME:home,GUEST_NAME:away,LEAGUE_NAME_SIMPLY:league,MATCH_TIME:kickoff,listOdds:[2,3,22].map(company=>({SOURCE_COMPANY_ID:company,COMPANY_NAME:`测试公司${company}`,WIN:2.1,SAME:3.2,LOST:3.4,HANDICAP:-.25,HOST:.9,GUEST:.9,DW_HANDICAP:2.5,BIG:.9,SMALL:.9,FIRST_WIN:2.2,FIRST_SAME:3.2,FIRST_LOST:3.3,FIRST_HANDICAP:-.25,FIRST_HOST:.9,FIRST_GUEST:.9,DW_FIRST_HANDICAP:2.5,FIRST_BIG:.9,FIRST_SMALL:.9}))}));
 const {POST}=await loadRoute(),originalFetch=globalThis.fetch;
 globalThis.fetch=async(url)=>{assert.equal(url,"https://plzx.zgzcw.com/odds/oyzs_ajax.action");return Response.json(external)};
 const predict=matches=>POST(new Request("http://localhost/api/predictions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({matches})}));
 try{
  const response=await predict(official),result=await response.json();
  assert.equal(response.status,200);
  assert.deepEqual(result.coverage,{officialMatches:fixtures.length,predictedMatches:fixtures.length-1,unavailableMatches:1,pendingExternalMappings:1});
  assert.equal(result.reports.length,fixtures.length-1);
  for(const match of official.slice(0,-1)){
   const report=result.reports.find(item=>item.officialMatchId===match.officialMatchId);
   assert.ok(report,match.id);
   assert.equal(report.home,match.home);assert.equal(report.away,match.away);
   assert.equal(report.officialMappingStatus,"verified");
   assert.equal(report.predictionId,result.predictionId);
   assert.equal(report.companies.length,3);
   assert.ok(report.scores.length>0);
  }
  assert.equal(result.unavailableOfficialMatches[0].officialMatchId,"test-014");
  assert.match(result.unavailableOfficialMatches[0].reason,/主客队顺序.*相反/);
  assert.equal(result.pendingVerification[0].candidateOfficialMatchIds.includes("test-014"),true);

  for(const changed of [
   {...official[0],kickoffAt:"2026-09-13T23:00:00+08:00"},
   {...official[0],kickoffAt:"2026-09-14T21:00:00+08:00"},
   {...official[0],home:official[0].away,away:official[0].home},
   {...official[0],away:"另一支球队"},
  ]){
   const rejected=await (await predict([changed,...official.slice(1)])).json();
   assert.equal(rejected.reports.some(row=>row.officialMatchId==="test-002"),false,"Alias recognition must not bypass other identity checks");
   assert.equal(rejected.unavailableOfficialMatches.some(row=>row.officialMatchId==="test-002"),true);
  }
  const ambiguous=await (await predict([...official,{...official[0],officialMatchId:"duplicate-match"}])).json();
  assert.equal(ambiguous.reports.some(row=>row.id==="周一002"),false);
  assert.match(ambiguous.pendingVerification.find(row=>row.displayId==="周一002").reason,/无法唯一确认/);
 }finally{globalThis.fetch=originalFetch}
});

test("coverage panel renders visible missing-match reasons and is wired into both forecast views",async()=>{
 const config=compile(await readFile(new URL("../app/prediction-config.ts",import.meta.url),"utf8"));
 const source=(await readFile(new URL("../app/components/PredictionCoverage.tsx",import.meta.url),"utf8")).replace('from "../prediction-config"',`from ${JSON.stringify(config)}`);
 const output=ts.transpileModule(source,{fileName:"Coverage.tsx",compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText.replace('from "react/jsx-runtime"',`from ${JSON.stringify(import.meta.resolve("react/jsx-runtime"))}`);
 const {default:Coverage}=await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
 const coverage={officialMatches:12,predictedMatches:11,unavailableMatches:1};
 const unavailableMatches=[{id:"周一014",officialMatchId:"test-014",league:"亚运女足",home:"中国女",away:"中国港女",kickoffAt:"2026-09-14T18:00:00+08:00",reason:"主客队顺序相反，暂停生成预测"}];
 const html=renderToStaticMarkup(createElement(Coverage,{coverage,unavailableMatches,predictedCount:11}));
 assert.match(html,/已生成 11 \/ 12 场预测/);
 assert.match(html,/周一014/);assert.match(html,/09\/14 18:00/);assert.match(html,/主客队顺序相反/);
 assert.doesNotMatch(html,/<details|hidden=/,"The missing match must be visible, not hidden behind an expansion");
 assert.equal(renderToStaticMarkup(createElement(Coverage,{predictedCount:0})),"");
 const complete=renderToStaticMarkup(createElement(Coverage,{coverage:{officialMatches:11,predictedMatches:11,unavailableMatches:0},predictedCount:11}));
 assert.match(complete,/全部场次已覆盖/);assert.doesNotMatch(complete,/<ul/);
 const [page,ai,market]=await Promise.all(["../app/page.tsx","../app/components/AiPredictionReport.tsx","../app/components/MarketPredictionTable.tsx"].map(path=>readFile(new URL(path,import.meta.url),"utf8")));
 assert.equal((page.match(/coverage=\{predictionCoverage\} unavailableMatches=\{unavailablePredictions\}/g)||[]).length,2);
 assert.match(page,/const unavailable=predictionMatches\.filter/);
 assert.match(page,/setPredictionCoverage\(null\);setUnavailablePredictions\(\[\]\)/);
 assert.match(ai,/<PredictionCoverage /);assert.match(market,/<PredictionCoverage /);
});
