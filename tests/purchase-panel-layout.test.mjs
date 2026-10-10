import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

test("purchase panel separates intro, snapshot status and controls without changing actions",async()=>{
 const component=await readFile(new URL("../app/components/TodayRecommendations.tsx",import.meta.url),"utf8"),css=await readFile(new URL("../app/reference-ui.css",import.meta.url),"utf8");
 assert.match(component,/header className="purchase-panel-header"/);
 assert.match(component,/className="purchase-snapshot-status" role="status"/);
 assert.match(component,/className="purchase-snapshot-select"/);
 assert.match(component,/onClick=\{\(\)=>setArchiveReload\(value=>value\+1\)\}/);
 assert.match(component,/onClick=\{\(\)=>void preview\(\)\}/);
 assert.match(css,/purchase-snapshot-toolbar button\{[^}]*flex:0 0 auto[^}]*white-space:nowrap/);
 assert.match(css,/purchase-kanban\{grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
 assert.match(css,/@media\(max-width:767px\)[^]*purchase-kanban\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});
