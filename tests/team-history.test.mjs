import test from "node:test";
import assert from "node:assert/strict";
import {buildTeamHistoryIndex,selectTeamHistory} from "../app/team-history.js";
const fixture={date:"2026-09-25",completedBefore:"2026-09-25T23:59:59+08:00",observedAt:"2026-09-27T16:00:00+08:00",homeTeamId:"h",awayTeamId:"a",homeGoals:2,awayGoals:1,league:"L",sourceUrl:"https://www.sporttery.cn/example"};
const raw=f=>({snapshotId:"s",immutable:true,capturedAt:"2026-09-27T16:10:00+08:00",reports:[{officialMappingStatus:"verified",modelInput:{matchContext:{fixtures:[f]}}}]});
test("stable history excludes evidence first observed after decision and handles conflicting results",()=>{
 const index=buildTeamHistoryIndex([raw(fixture),raw(fixture)]);
 assert.equal(index.rows.length,1);
 assert.equal(selectTeamHistory(index,{league:"L",decisionAt:"2026-09-26T17:00:00+08:00"}).rows.length,0);
 const selected=selectTeamHistory(index,{league:"L",decisionAt:"2026-09-28T17:00:00+08:00"});
 assert.equal(selected.rows.length,1);assert.equal(selected.usesCurrentRequest,false);
 const conflict=buildTeamHistoryIndex([raw(fixture),raw({...fixture,awayGoals:3})]);
 assert.equal(selectTeamHistory(conflict,{league:"L",decisionAt:"2026-09-28T17:00:00+08:00"}).rows.length,0);
 assert.equal(selectTeamHistory(conflict,{league:"L",decisionAt:"2026-09-28T17:00:00+08:00"}).conflicts.length,1);
});
test("missing observation time and mock sources never become team-model training rows",()=>{
 assert.equal(buildTeamHistoryIndex([raw({...fixture,observedAt:null}),{...raw(fixture),immutable:false}]).rows.length,0);
});
