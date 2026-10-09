// Loaded only by isolated subprocess tests whose cwd is an OS temporary directory.
const NativeDate=Date;
const now=Number(process.env.TEST_CAPTURE_NOW);
globalThis.Date=class extends NativeDate {
 constructor(...args){super(...(args.length?args:[now]));}
 static now(){return now;}
};
const match={id:"001",matchId:"test-official-001",officialMatchId:"test-official-001",salesDate:"2026-10-09",kickoffAt:"2026-10-09T23:00:00+08:00",home:"隔离甲",away:"隔离乙",matchStatus:"Selling",marketEligibility:{had:{qualification:"qualified",salesStatus:"Selling",cutoffAt:"2026-10-09T22:59:00+08:00"}}};
const report={...match,officialMappingStatus:"verified",predictionId:"isolated-test-prediction",fullScoreDistribution:[{score:"1:0",probability:100}],probabilities:{home:100,draw:0,away:0},marketSignal:{modeledTotalGoals:[0,100,0,0,0,0,0,0],modeledHalfFull:[100,0,0,0,0,0,0,0,0]}};
if(process.env.TEST_CAPTURE_MISSING_CUTOFF==="1")match.marketEligibility.had.cutoffAt=null;
const matches=process.env.TEST_CAPTURE_COMPLETE==="1"?Array.from({length:5},(_,index)=>({...match,id:`测试${index}`,matchId:`isolated-${index}`,officialMatchId:`isolated-${index}`,marketOdds:{"胜平负":[2,3,4],"总进球数":[10,4,5,6,7,8,9,10]},marketEligibility:{"胜平负":{marketCode:"HAD",qualification:"qualified",salesStatus:"Selling",allowedPassCounts:[2,3,4,5],cutoffAt:"2026-10-09T22:59:00+08:00"},"总进球数":{marketCode:"TTG",qualification:"qualified",salesStatus:"Selling",allowedPassCounts:[2,3,4,5],cutoffAt:"2026-10-09T22:59:00+08:00"}}})):[match];
const reports=matches.map(item=>({...report,...item,sourceFetchedAt:new Date(now).toISOString()}));
if(process.env.TEST_CAPTURE_PARTIAL==="1")reports.pop();
if(process.env.TEST_CAPTURE_CLOSED==="1")for(const item of matches)item.matchStatus="Stopped";
if(process.env.TEST_CAPTURE_MISSING_CUTOFF==="1")for(const item of matches)for(const market of Object.values(item.marketEligibility))market.cutoffAt=null;
globalThis.fetch=async url=>new Response(JSON.stringify(String(url).endsWith("/api/sporttery")?{matches,fetchedAt:new Date(now).toISOString()}:{reports,predictionId:report.predictionId,version:{predictionId:report.predictionId,inputSnapshotId:"isolated-input"},fetchedAt:new Date(now).toISOString()}),{headers:{"Content-Type":"application/json"}});
