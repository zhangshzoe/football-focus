import test from "node:test";
import assert from "node:assert/strict";
import { resolveServerOfficialMatches } from "../app/server-official-evidence.js";
import { decisionCaptureWindow, selectDecisionCaptureMatches, assertDecisionCaptureComplete } from "../app/prediction-capture-policy.js";
import { expectedHalfFullDistribution } from "../app/half-full-validation.js";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Synthetic response fixtures remain in memory; never written as real snapshots.
const at = "2026-10-01T08:45:00.000Z",
  date = "2026-10-01",
  now = Date.parse(at);
function fixture() {
  const match = {
    officialMatchId: "123",
    matchId: "123",
    salesDate: date,
    kickoffAt: "2026-10-01T23:00:00+08:00",
    odds: [2, 3, 4],
    marketOdds: { 让球胜平负: [3, 3, 2], 总进球数: [12, 8, 4, 3, 6, 12, 20, 30] },
    marketEligibility: { 让球胜平负: { qualification: "qualified", handicap: "-1" } },
  };
  const input = {
    officialMatchId: "123",
    salesDate: date,
    kickoffAt: match.kickoffAt,
    fetchedAt: at,
    hadOdds: match.odds,
    handicap: -1,
    hhadOdds: match.marketOdds["让球胜平负"],
    totalOdds: match.marketOdds["总进球数"],
    scoreOdds: [],
    halfFullOdds: [],
  };
  const report = {
    officialMatchId: "123",
    officialMappingStatus: "verified",
    officialVerification: { method: "server-refetch", fetchedAt: at },
    modelInput: { official: input },
  };
  return {
    selection: [{ officialMatchId: "123", odds: [99, 99, 99] }],
    prediction: {
      officialSource: {
        method: "server-refetch",
        fetchedAt: at,
        manifestState: "complete",
        poolStatus: Object.fromEntries(
          ["HAD", "HHAD", "CRS", "TTG", "HAFU"].map((pool) => [
            pool,
            { status: "success", observedAt: at },
          ]),
        ),
      },
      officialMatches: [match],
      reports: [report],
    },
  };
}

function decisionFixture() {
  const date="2026-10-02", at="2026-10-02T12:50:00+08:00";
  const match={id:"周五001",officialMatchId:"123",matchId:"123",salesDate:date,home:"Synthetic home",away:"Synthetic away",
    kickoffAt:"2026-10-02T13:30:00+08:00",matchStatus:"Selling",odds:[2,3,4],marketOdds:{"总进球数":Array(8).fill(8),"比分":Array(31).fill(31),"半全场":Array(9).fill(9)},
    marketEligibility:{"胜平负":{qualification:"qualified",salesStatus:"Selling",cutoffAt:"2026-10-02T13:20:00+08:00"},"让球胜平负":{qualification:"unavailable"}}};
  const grid=Array.from({length:169},(_,i)=>({score:`${Math.floor(i/13)}:${i%13}`,probability:100/169})), totals=Array(8).fill(0);
  for(const point of grid){const[h,a]=point.score.split(":").map(Number);totals[Math.min(7,h+a)]+=point.probability;}
  const report={...match,officialMappingStatus:"verified",officialVerification:{method:"server-refetch",fetchedAt:at},sourceFetchedAt:at,predictionGeneratedAt:at,
    predictionId:"isolated-test-prediction",inputSnapshotId:"isolated-input",baseModelVersion:"isolated-model",
    fullScoreDistribution:grid,probabilities:{home:100*78/169,draw:100*13/169,away:100*78/169},modelParameters:{firstHalfGoalShare:.45},
    modelInput:{decisionAt:at,official:{officialMatchId:"123",salesDate:date,kickoffAt:match.kickoffAt,fetchedAt:at,hadOdds:match.odds,handicap:null,hhadOdds:[],totalOdds:match.marketOdds["总进球数"],scoreOdds:match.marketOdds["比分"],halfFullOdds:match.marketOdds["半全场"]}},
    marketSignal:{modeledTotalGoals:totals,modeledHalfFull:expectedHalfFullDistribution(grid,{firstHalfGoalShare:.45})}};
  const poolStatus=Object.fromEntries(["HAD","HHAD","CRS","TTG","HAFU"].map(pool=>[pool,{status:"success",observedAt:at}]));
  const prediction={officialMatches:[match],reports:[report],fetchedAt:at,predictionId:report.predictionId,version:{predictionId:report.predictionId,inputSnapshotId:"isolated-input",generatedAt:at},
    officialSource:{method:"server-refetch",fetchedAt:at,manifestState:"complete",poolStatus}};
  return {date,at,now:Date.parse(at),match,report,prediction,poolStatus};
}

test("decision capture selects only this sale day's exact pre-target window",()=>{
  const f=decisionFixture(), later={...f.match,officialMatchId:"456",kickoffAt:"2026-10-02T23:30:00+08:00"};
  const otherDay={...f.match,officialMatchId:"789",salesDate:"2026-10-03",kickoffAt:"2026-10-03T13:30:00+08:00"};
  assert.deepEqual(selectDecisionCaptureMatches([f.match,later,otherDay],f.date,"1300",f.now),[f.match]);
  assert.equal(decisionCaptureWindow(f.date,"1300",Date.parse("2026-10-02T12:45:00+08:00")).allowed,true);
  for(const at of ["12:44:59","13:00:00","13:30:00"])assert.equal(decisionCaptureWindow(f.date,"1300",Date.parse(`${f.date}T${at}+08:00`)).allowed,false);
  assert.throws(()=>selectDecisionCaptureMatches([f.match,f.match],f.date,"1300",f.now),/重复/);
  const weekend={...later,salesDate:"2026-10-03",kickoffAt:"2026-10-04T02:00:00+08:00"};
  assert.equal(selectDecisionCaptureMatches([weekend],"2026-10-03","2230",Date.parse("2026-10-03T22:20:00+08:00")).length,1);
});

test("completion rejects late, partial, changed-identity, stale, closed and inconsistent decision evidence",()=>{
  const good=decisionFixture();
  assert.equal(assertDecisionCaptureComplete(good.prediction,[good.match],good.date,"1300",good.now).length,1);
  for(const mutate of [
    f=>f.prediction.reports.pop(),
    f=>f.report.home="Changed home",
    f=>f.report.kickoffAt="2026-10-02T13:40:00+08:00",
    f=>f.report.modelInput.decisionAt="2026-10-02T12:44:59+08:00",
    f=>f.report.predictionGeneratedAt="2026-10-02T12:51:00+08:00",
    f=>f.prediction.officialSource.poolStatus.TTG.observedAt="2026-10-02T12:44:59+08:00",
    f=>f.match.marketEligibility["胜平负"].cutoffAt=f.at,
    f=>f.match.matchStatus="Closed",
    f=>f.match.odds[0]=null,
    f=>f.report.marketSignal.modeledTotalGoals=Array(8).fill(12.5),
    f=>f.report.marketSignal.modeledHalfFull[0]=NaN,
  ]){
    const f=decisionFixture();mutate(f);
    assert.throws(()=>assertDecisionCaptureComplete(f.prediction,[f.match],f.date,"1300",f.now));
  }
  assert.throws(()=>assertDecisionCaptureComplete(good.prediction,[good.match],good.date,"1300",Date.parse("2026-10-02T13:00:00+08:00")),{code:"CAPTURE_LATE"});
});

// Run the real CLI with isolated transport/clock and an OS-temporary data root.
// Synthetic successful snapshots never enter the project's data/ or statistics.
test("real capture CLI excludes unrelated fixtures, preserves originals and never writes late or partial batches",async(t)=>{
  const run=promisify(execFile), script=fileURLToPath(new URL("../scripts/capture-prediction-snapshot.mjs",import.meta.url));
  for(const scenario of ["saved","late","partial","existing"]){
    await t.test(scenario,async()=>{
      const root=await mkdtemp(join(tmpdir(),"football-decision-capture-"));
      try{
        const f=decisionFixture(), later={...f.match,officialMatchId:"456",matchId:"456",kickoffAt:"2026-10-02T23:30:00+08:00"};
        const source={matches:[f.match,later],fetchedAt:f.at,poolStatus:f.poolStatus};
        if(scenario==="partial")f.prediction.reports=[];
        const directory=join(root,"data","prediction-snapshots"),rawPath=join(directory,"2026-10-02_1300.raw.json");
        await mkdir(directory,{recursive:true});
        const original='{"snapshotId":"preserved-original","reports":[]}\n';
        if(scenario==="existing")await writeFile(rawPath,original);
        const loader=join(root,"transport.mjs");
        await writeFile(loader,`import assert from "node:assert/strict";
const NativeDate=Date;let clock=NativeDate.parse(${JSON.stringify(f.at)});
globalThis.Date=class extends NativeDate {constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}};
globalThis.fetch=async(url,options)=>{
 if(${JSON.stringify(scenario)}==="existing")throw Error("existing capture must not fetch");
 if(String(url).endsWith("/api/sporttery"))return Response.json(${JSON.stringify(source)});
 if(String(url).endsWith("/api/predictions")){
  assert.deepEqual(JSON.parse(options.body).fixtureIds,["123"]);
  if(${JSON.stringify(scenario)}==="late")clock=NativeDate.parse("2026-10-02T13:00:01+08:00");
  return Response.json(${JSON.stringify(f.prediction)});
 }
 throw Error("unexpected URL");
};`);
        const args=["--import",pathToFileURL(loader).href,script,"1300"],options={cwd:root,env:{...process.env,FOOTBALL_FOCUS_URL:"http://isolated-capture.test.invalid"},timeout:15000};
        if(["late","partial"].includes(scenario)){
          await assert.rejects(run(process.execPath,args,options));
          assert.deepEqual(await readdir(directory),[]);
        }else{
          const result=await run(process.execPath,args,options);
          const outcome=JSON.parse(result.stdout.trim().split("\n").at(-1));
          if(scenario==="existing"){assert.equal(outcome.status,"exists");assert.equal(await readFile(rawPath,"utf8"),original);}
          else{
            assert.equal(outcome.status,"saved");
            const raw=JSON.parse(await readFile(rawPath,"utf8"));
            assert.deepEqual(raw.reports.map(row=>row.officialMatchId),["123"]);
            assert.deepEqual(raw.officialMatches.map(row=>row.officialMatchId),["123"]);
            assert.equal(outcome.captureTiming,"on-time");
            const names=await readdir(join(root,"data","capture-attempts"));
            const audit=JSON.parse(await readFile(join(root,"data","capture-attempts",names[0]),"utf8"));
            assert.equal(audit.officialManifest.length,2);
            assert.deepEqual(audit.selectedOfficialMatchIds,["123"]);
          }
        }
      }finally{await rm(root,{recursive:true,force:true});}
    });
  }
});
test("capture uses server quotes rather than the earlier client/list quotes", () => {
  const { prediction, selection } = fixture();
  const matches = resolveServerOfficialMatches(prediction, selection, date, now);
  assert.deepEqual(matches[0].odds, [2, 3, 4]);
  assert.equal(matches, prediction.officialMatches);
});

test("formal capture rejects incomplete five-market rereads even with matching quotes", () => {
  for (const change of [
    (s) => delete s.manifestState,
    (s) => (s.manifestState = "partial"),
    (s) => (s.manifestState = "unknown"),
    (s) => delete s.poolStatus,
    (s) => delete s.poolStatus.CRS,
    (s) => (s.poolStatus.TTG.status = "failed"),
  ]) {
    const { prediction, selection } = fixture();
    change(prediction.officialSource);
    assert.throws(
      () => resolveServerOfficialMatches(prediction, selection, date, now),
      /完整五玩法.*读取证明/,
    );
  }
  const { prediction, selection } = fixture();
  prediction.officialSource.poolStatus.HAD.issues = [
    { source: "primary", kind: "access-blocked", httpStatus: 567, detail: "blocked" },
  ];
  assert.equal(
    resolveServerOfficialMatches(prediction, selection, date, now),
    prediction.officialMatches,
  );
});
test("missing, future and stale server observation times fail closed", () => {
  for (const fetchedAt of [
    null,
    "bad-time",
    new Date(now + 1).toISOString(),
    new Date(now - 300001).toISOString(),
  ]) {
    const { prediction, selection } = fixture();
    prediction.officialSource.fetchedAt = fetchedAt;
    assert.throws(() => resolveServerOfficialMatches(prediction, selection, date, now), /读取证明/);
  }
  const { prediction, selection } = fixture();
  delete prediction.officialSource;
  assert.throws(() => resolveServerOfficialMatches(prediction, selection, date, now), /读取证明/);
});
test("incomplete, duplicate, mock and wrong-day official universes cannot be frozen", () => {
  for (const change of [
    (p) => (p.officialMatches = []),
    (p) => p.officialMatches.push(p.officialMatches[0]),
    (p) => (p.officialMatches[0].officialMatchId = "456"),
    (p) => (p.officialMatches[0].isMock = true),
    (p) => (p.officialMatches[0].salesDate = "2026-10-02"),
    (p) => (p.officialMatches[0].kickoffAt = "bad-time"),
  ]) {
    const { prediction, selection } = fixture();
    change(prediction);
    assert.throws(
      () => resolveServerOfficialMatches(prediction, selection, date, now),
      /清单覆盖|身份/,
    );
  }
});

test("a fresh global timestamp cannot refresh a missing or stale pool observation", () => {
  for (const observedAt of [
    undefined,
    "bad-time",
    new Date(now + 1).toISOString(),
    new Date(now - 300001).toISOString(),
  ]) {
    const { prediction, selection } = fixture();
    prediction.officialSource.poolStatus.TTG.observedAt = observedAt;
    assert.throws(
      () => resolveServerOfficialMatches(prediction, selection, date, now),
      /逐玩法新鲜读取证明/,
    );
  }
});
test("each frozen forecast must retain the same identity, server time and all five quotes", () => {
  for (const change of [
    (r) => (r.officialMappingStatus = "pending_verification"),
    (r) => (r.officialMatchId = "456"),
    (r) => delete r.officialVerification,
    (r) => (r.modelInput.official.fetchedAt = "later"),
    (r) => (r.modelInput.official.hadOdds = [99, 99, 99]),
    (r) => (r.modelInput.official.totalOdds = Array(8).fill(99)),
    (r) => (r.modelInput.official.scoreOdds = [1]),
    (r) => (r.modelInput.official.halfFullOdds = [1]),
    (r) => (r.modelInput.official.hhadOdds = [99, 99, 99]),
  ]) {
    const { prediction, selection } = fixture();
    change(prediction.reports[0]);
    assert.throws(
      () => resolveServerOfficialMatches(prediction, selection, date, now),
      /读取证明|赔率/,
    );
  }
  const { prediction, selection } = fixture();
  prediction.reports.push(prediction.reports[0]);
  assert.throws(() => resolveServerOfficialMatches(prediction, selection, date, now), /读取证明/);
});

test("official fixed handicap and qualification are bound, including a genuine zero line", () => {
  for (const change of [
    (p) => (p.reports[0].modelInput.official.handicap = 1),
    (p) => delete p.reports[0].modelInput.official.handicap,
    (p) => (p.officialMatches[0].marketEligibility["让球胜平负"].handicap = null),
    (p) => (p.officialMatches[0].marketEligibility["让球胜平负"].handicap = ""),
    (p) => (p.officialMatches[0].marketEligibility["让球胜平负"].handicap = "-0.25"),
    (p) => (p.officialMatches[0].marketEligibility["让球胜平负"].qualification = "not_selling"),
  ]) {
    const { prediction, selection } = fixture();
    change(prediction);
    assert.throws(
      () => resolveServerOfficialMatches(prediction, selection, date, now),
      (error) => error.code === "OFFICIAL_HANDICAP_MISMATCH",
    );
  }
  const { prediction, selection } = fixture();
  prediction.officialMatches[0].marketEligibility["让球胜平负"].handicap = "0";
  prediction.reports[0].modelInput.official.handicap = 0;
  assert.equal(
    resolveServerOfficialMatches(prediction, selection, date, now),
    prediction.officialMatches,
  );
  prediction.officialMatches[0].marketEligibility["让球胜平负"].qualification = "not_selling";
  prediction.reports[0].modelInput.official.handicap = null;
  prediction.reports[0].modelInput.official.hhadOdds = [];
  assert.equal(
    resolveServerOfficialMatches(prediction, selection, date, now),
    prediction.officialMatches,
  );
});
