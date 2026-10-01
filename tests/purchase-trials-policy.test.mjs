import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import ts from "typescript";
import {PURCHASE_PLAN_DEFINITIONS,PURCHASE_PLAN_VERSION} from "../app/purchase-plan-engine.js";
import {DEFAULT_RECOMMENDATION_POLICY} from "../app/recommendation-policy.js";

const date="2026-10-01",userId="purchase-policy-test-user";
let moduleSequence=0;
const leg=(id,{market="score",probability=80,odd=2,pick="1:0"}={})=>({
 officialMatchId:id,salesDate:date,league:"测试联赛",market,
 picks:[{pick,probability,odd}],
});
const plan=(id="score-single-2",items=[leg("a"),leg("b")])=>({
 id,status:"pending",stake:2,betCount:1,items,
});
const trial=(overrides={})=>({
 version:PURCHASE_PLAN_VERSION,snapshotId:"manual-trial-00000000-0000-4000-8000-000000000001",
 date,generatedAt:date+"T17:02:00+08:00",scheduledTime:"17:00",source:"test-only",
 riskSelection:{policy:{...DEFAULT_RECOMMENDATION_POLICY}},
 decisionSummary:{evaluated:true,noBet:false,coverage:{missingEligibleCount:0}},
 plans:[plan()],...overrides,
});
const noBet=()=>trial({
 plans:PURCHASE_PLAN_DEFINITIONS.map(definition=>({id:definition.id,status:"unavailable",stake:0,betCount:0,items:[]})),
 decisionSummary:{evaluated:true,noBet:true,coverage:{missingEligibleCount:0}},
});
function memoryDatabase(initial=[]){
 const rows=initial.map(record=>({...record})),writes=[],queries=[];
 return {rows,writes,queries,prepare(sql){
  queries.push(sql);
  return {bind(...values){
   return {
    async all(){assert.match(sql,/^SELECT payload_json /);return {results:rows.filter(row=>row.userId===values[0]).map(row=>({payload_json:row.payload_json}))};},
    async run(){
     assert.match(sql,/^INSERT OR IGNORE INTO saved_purchase_trials /);
     writes.push(values);
     if(!rows.some(row=>row.id===values[0]))rows.push({id:values[0],userId:values[1],payload_json:values[4]});
     return {success:true};
    },
   };
  }};
 }};
}
async function loadRoute({earlier=[],records=[]}={}){
 const db=memoryDatabase(records);
 let source=await readFile(new URL("../app/api/purchase-trials/route.ts",import.meta.url),"utf8");
 source=source
  .replace('import { env } from "cloudflare:workers";','const env=globalThis.__purchaseTrialsTestEnv;')
  .replace('import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";','const forbiddenFileAccess=async()=>{throw new Error("Tests must not read or write saved trial files");}; const mkdir=forbiddenFileAccess,readFile=forbiddenFileAccess,readdir=forbiddenFileAccess,writeFile=forbiddenFileAccess;')
  .replace('import { NextResponse } from "next/server";','const NextResponse={json:(body,init)=>Response.json(body,init)};')
  .replace('import {readServerPurchaseHistory} from "../../server-purchase-history";',"const readServerPurchaseHistory=async()=>"+JSON.stringify(earlier)+";")
  .replace(/process\.env\.NODE_ENV/g,'"production"')
  .replace(/from "(\.\.\/\.\.\/[^"]+\.js)"/g,(_,specifier)=>"from "+JSON.stringify(new URL(specifier,new URL("../app/api/purchase-trials/route.ts",import.meta.url)).href));
 source+="\nconst __isolatedTestModule="+(++moduleSequence)+";";
 const js=ts.transpileModule(source,{fileName:"purchase-trials-route.ts",compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 globalThis.__purchaseTrialsTestEnv={DB:db};
 try{return {...await import("data:text/javascript;base64,"+Buffer.from(js).toString("base64")),db};}
 finally{delete globalThis.__purchaseTrialsTestEnv;}
}
const post=(route,value)=>route.POST(new Request("http://localhost/api/purchase-trials",{
 method:"POST",headers:{"Content-Type":"application/json","oai-authenticated-user-id":userId},body:JSON.stringify(value),
}));
async function rejected(route,value,reason){
 const response=await post(route,value),body=await response.json();
 assert.equal(response.status,400,JSON.stringify(body));assert.match(body.error,reason);
 assert.equal(route.db.writes.length,0,"Rejected original tickets must never be persisted");
}

test("new POST rejects missing, lower and unsupported versions without silently upgrading the original",async()=>{
 const route=await loadRoute();
 for(const version of [undefined,0,15,PURCHASE_PLAN_VERSION-1,PURCHASE_PLAN_VERSION+1]){
  await rejected(route,trial({version}),/版本.*缺失|版本.*过期|当前版本/);
 }
});

test("current POST rejects half-full, negative EV, insufficient margin and stress-failing tickets",async()=>{
 const route=await loadRoute();
 await rejected(route,trial({plans:[plan("half-full-double-2",[leg("a",{market:"halfFull",pick:"胜胜"}),leg("b",{market:"halfFull",pick:"胜胜"})])]}),/半全场.*研究/);
 await rejected(route,trial({plans:[plan("score-single-2",[leg("a",{probability:30}),leg("b",{probability:30})])]}),/期望收益不为正/);
 await rejected(route,trial({plans:[plan("score-single-2",[leg("a",{probability:50,odd:2.04}),leg("b",{probability:50,odd:2.04})])]}),/收益余量不足/);
 await rejected(route,trial({plans:[plan("score-single-2",[leg("a",{probability:50,odd:2.1}),leg("b",{probability:50,odd:2.1})])]}),/概率下调后优势消失/);
});

test("over-budget original cannot be saved by substituting an unpersisted cheap alternative",async()=>{
 const route=await loadRoute(),value=trial();
 const double=plan("score-double-2",[leg("a",{odd:3}),leg("b",{odd:3})]);
 double.items.forEach(item=>item.picks.push({pick:"0:0",probability:20,odd:3}));
 double.stake=8;double.betCount=4;
 double.candidateAlternatives=[plan("score-double-2")];
 value.plans=[double];value.riskSelection.policy.dailyBudget=2;
 await rejected(route,value,/每日模拟.*预算|每日模拟额度/);
});

test("new POST rejects duplicate tickets and excessive same-fixture overlap",async()=>{
 const route=await loadRoute();
 const a=plan("twofold-a",[leg("a",{market:"had",pick:"胜"}),leg("b",{market:"had",pick:"胜"})]);
 await rejected(route,trial({plans:[a,{...structuredClone(a),id:"twofold-b"}]}),/同一张票/);
 const different=plan("twofold-b",[leg("a",{market:"total",pick:"2球"}),leg("b",{market:"total",pick:"2球"})]);
 await rejected(route,trial({plans:[a,different]}),/共享场次过多/);
});

test("missing or invalid slot is rejected and 21:00 includes verified 17:00 stake",async()=>{
 const early={snapshotId:"test-early",planSet:{date,scheduledTime:"17:00",generatedAt:date+"T17:00:00+08:00",plans:[plan("score-single-2",[leg("early-a"),leg("early-b")])]}};
 const route=await loadRoute({earlier:[early]});
 for(const scheduledTime of [undefined,"","20:00"])await rejected(route,trial({scheduledTime}),/批次时点.*缺失|批次时点.*无效/);
 const late=trial({scheduledTime:"21:00"});late.riskSelection.policy.dailyBudget=2;
 await rejected(route,late,/每日模拟.*预算|每日模拟额度/);
 const absent=await loadRoute();await rejected(absent,trial({scheduledTime:"21:00"}),/早批次投入记录缺失或冲突/);
 const current=await loadRoute({earlier:[early,{snapshotId:"fresh-cloud",planSet:{...early.planSet,plans:[plan("score-single-2",[leg("cloud-a"),leg("cloud-b")])]}}]});
 const over=trial({scheduledTime:"21:00"});over.riskSelection.policy.dailyBudget=4;
 await rejected(current,over,/每日模拟.*预算|每日模拟额度/);
 const legal=trial({scheduledTime:"21:00"});legal.riskSelection.policy.dailyBudget=6;
 const response=await post(current,legal);assert.equal(response.status,200,JSON.stringify(await response.json()));
});

test("new POST rejects forged amounts and type metadata without modifying the original picks",async()=>{
 const route=await loadRoute();
 for(const change of [{stake:1},{betCount:2},{items:[leg("a")]}]){
  const value=trial();Object.assign(value.plans[0],change);await rejected(route,value,/冻结投入或注数|场数、玩法/);
 }
 const value=trial();value.plans[0].items[0].salesDate="2026-09-30";
 await rejected(route,value,/销售日期/);
});

test("legal current original ticket is saved exactly and current complete no-bet remains savable",async()=>{
 const route=await loadRoute(),value=trial(),original=structuredClone(value);
 const response=await post(route,value),saved=(await response.json()).trial;
 assert.equal(response.status,200);assert.deepEqual(saved.plans,original.plans);
 assert.equal(saved.version,PURCHASE_PLAN_VERSION);assert.equal(saved.scheduledTime,"17:00");assert.equal(route.db.writes.length,1);
 assert.deepEqual(value,original,"Validation must not mutate the request fixture");
 const empty=await loadRoute(),decision=noBet();decision.riskSelection.policy.dailyBudget=0;
 const none=await post(empty,decision),body=await none.json();
 assert.equal(none.status,200,JSON.stringify(body));assert.deepEqual(body.trial.plans,decision.plans);assert.equal(empty.db.writes.length,1);
});

test("incomplete, duplicated or contradictory no-bet cannot masquerade as a complete evaluation",async()=>{
 const route=await loadRoute();
 const missing=noBet();missing.decisionSummary.coverage.missingEligibleCount=1;
 await rejected(route,missing,/完整评估/);
 const duplicate=noBet();duplicate.plans[1]=structuredClone(duplicate.plans[0]);await rejected(route,duplicate,/重复类型/);
 const hidden=noBet();hidden.plans[0].items=[leg("hidden")];await rejected(route,hidden,/仍含投注选项/);
 const contradictory=trial();contradictory.decisionSummary.noBet=true;await rejected(route,contradictory,/声明与原票不一致/);
});

test("historical GET returns legacy payload unchanged and performs no migration writes",async()=>{
 const legacy=trial({version:14,scheduledTime:undefined});
 legacy.plans[0].items[0].market="halfFull";legacy.plans[0].stake=123;
 const original=JSON.stringify(legacy),route=await loadRoute({records:[{id:legacy.snapshotId,userId,payload_json:original}]});
 const response=await route.GET(new Request("http://localhost/api/purchase-trials",{headers:{"oai-authenticated-user-id":userId}}));
 assert.equal(response.status,200);assert.deepEqual((await response.json()).trials,[JSON.parse(original)]);
 assert.equal(route.db.rows[0].payload_json,original);assert.equal(route.db.writes.length,0);
 assert.equal(route.db.queries.length,1);assert.match(route.db.queries[0],/^SELECT /);
});

test("frozen choices must meet their named mode, probability and conditional-profit rules",async()=>{
 const route=await loadRoute();
 const doubleItems=["a","b"].map(id=>({...leg(id),picks:[{pick:"1:0",probability:80,odd:3},{pick:"0:0",probability:20,odd:1.1}]}));
 const negative={...plan("score-double-2",doubleItems),stake:8,betCount:4,minWinningProfit:999};
 const cases=[
  [plan("draw-or-handicap-draw-2",[leg("a",{market:"had",pick:"胜"}),leg("b",{market:"had",pick:"平"})]),/允许的选项/],
  [plan("had-safe-2",[leg("a",{market:"had",pick:"胜",probability:49,odd:3}),leg("b",{market:"had",pick:"胜"})]),/合计概率/],
  [plan("result-mixed-3",["a","b","c"].map(id=>leg(id,{market:"had",pick:"胜"}))),/至少包含2种玩法/],
  [negative,/最低命中净利不能为负/],
  [plan("tenfold-safe-2",["a","b"].map(id=>leg(id,{market:"had",pick:"胜",odd:3}))),/净利未达到目标/],
  [plan("twofold-a",["a","b"].map(id=>leg(id,{market:"had",pick:"胜",odd:1.5}))),/投入倍数门槛/],
 ];
 for(const [candidate,reason]of cases)await rejected(route,trial({plans:[candidate]}),reason);
});

test("valid probability and profit boundaries preserve every frozen choice",async()=>{
 const candidates=[
  plan("draw-or-handicap-draw-2",[leg("a",{market:"had",pick:"平"}),leg("b",{market:"hhad",pick:"让平"})]),
  plan("had-safe-2",[leg("a",{market:"had",pick:"胜",probability:50,odd:3}),leg("b",{market:"had",pick:"胜"})]),
  plan("twofold-a",[leg("a",{market:"had",pick:"胜",odd:2}),leg("b",{market:"total",pick:"2球",odd:1.5})]),
  plan("tenfold-safe-2",[leg("a",{market:"had",pick:"胜",odd:2}),leg("b",{market:"total",pick:"2球",odd:5.5})]),
 ];
 for(const candidate of candidates){const route=await loadRoute(),value=trial({plans:[candidate]}),response=await post(route,value),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.deepEqual(body.trial.plans,value.plans);}
});

test("scores alias cannot change economics for a separately validated picks array",async()=>{
 const route=await loadRoute(),value=trial();value.plans[0].items[0].scores=[{score:"3:3",probability:80,odd:2}];
 await rejected(route,value,/冻结选项须使用picks/);
});
