import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("repair action sits beside today's matches title without a separate explanation panel",async()=>{
 const page=await readFile(new URL("../app/page.tsx",import.meta.url),"utf8");
 assert.doesNotMatch(page,/比赛缺失或玩法未补全|className="match-repair-toolbar"/);
 assert.match(page,/<div className="match-title-actions"><h2>今日比赛<\/h2><button className="match-repair-button"[^>]*onClick=\{\(\)=>void repairMissingMatches\(\)\}[^>]*disabled=\{dataLoading\}/);
 assert.match(page,/className=\{`match-repair-notice[^\n]*role="status"/);
});
