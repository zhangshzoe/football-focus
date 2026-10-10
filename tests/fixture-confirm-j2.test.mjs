import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {manualMappingScopeCompatible,confirmedFixtureMapping} from "../app/team-identity.js";

test("Sunday 002 supports fixture-only confirmation across official J2 league labels",()=>{
 const official={id:"周日002",officialMatchId:"test-official-002",salesDate:"2026-10-11",kickoffAt:"2026-10-11T14:00:00+08:00",league:"日乙",home:"磐城FC",away:"秋田闪电"};
 const external={CC_ID:"周日002",ID:"test-external-002",MATCH_TIME:"2026-10-11 14:00:00",LEAGUE_NAME_SIMPLY:"日职乙",HOST_NAME:"磐城FC",GUEST_NAME:"秋田蓝闪电"};
 const now=Date.parse("2026-10-11T12:00:00+08:00");
 const record={...official,externalId:external.ID,externalHome:external.HOST_NAME,externalAway:external.GUEST_NAME,externalTime:external.MATCH_TIME,externalLeague:external.LEAGUE_NAME_SIMPLY,confirmedAt:new Date(now).toISOString()};
 assert.equal(manualMappingScopeCompatible(official,external),true);
 assert.equal(confirmedFixtureMapping(official,external,[record],now),record);
 assert.equal(confirmedFixtureMapping(official,external,[],now),null);
 for(const change of [{CC_ID:"周日003"},{LEAGUE_NAME_SIMPLY:"日职"},{MATCH_TIME:"2026-10-12 14:00:00"},{MATCH_TIME:"2026-10-11 16:00:00"},{HOST_NAME:official.away,GUEST_NAME:official.home}])assert.equal(manualMappingScopeCompatible(official,{...external,...change}),false);
 assert.equal(confirmedFixtureMapping(official,external,[record],now+24*3600000+1),null);
});

test("confirmation action appears after mapping details with responsive end alignment",async()=>{
 const component=await readFile(new URL("../app/components/PredictionCoverage.tsx",import.meta.url),"utf8"),css=await readFile(new URL("../app/reference-ui.css",import.meta.url),"utf8");
 assert.ok(component.indexOf('className="prediction-confirm-match"')>component.indexOf('className="prediction-mapping-reason"'));
 assert.match(component,/disabled=\{retrying\} onClick=\{\(\)=>confirmMatch\(match,candidate\)\}/);
 assert.match(css,/\.prediction-confirm-match\{justify-self:end/);
});
