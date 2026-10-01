import { env } from "cloudflare:workers";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyFirstObservedResult } from "./forward-validation.js";
import { requireCloudLease, cloudLeaseLost } from "./cloud-writer-lease.js";

export type ResultObservation = {eventId:string;fixtureKey:string;firstObservedAt:string;outcomeHash:string;recordType:string;immutable:boolean;[key:string]:unknown};
type Binding={prepare(sql:string):{bind(...values:(string|number)[]):{run():Promise<unknown>;all<T>():Promise<{results?:T[]}>}}};
export type ResearchWriterLease={scope:string;token:string;fence:number};
const db=()=>process.env.NODE_ENV==="production"?env.DB as Binding|undefined:undefined;
const directory=join(process.cwd(),"data","research-result-events");
const valid=(record:ResultObservation)=>verifyFirstObservedResult(record,{now:Date.now()});
const checked=(text:string):ResultObservation=>{const record=JSON.parse(text) as ResultObservation;if(!valid(record))throw new Error("首次观测赛果记录校验失败");return record;};
const earliest=(records:ResultObservation[])=>records.sort((a,b)=>Date.parse(a.firstObservedAt)-Date.parse(b.firstObservedAt))[0];
const recordName=/^result-[a-f0-9]{64}(?:\.[a-f0-9]{64})?\.json$/;

export async function readResearchResults():Promise<ResultObservation[]>{
  const database=db();
  if(database){const rows=await database.prepare("SELECT payload_json FROM research_result_events ORDER BY first_observed_at ASC").bind().all<{payload_json:string}>();return(rows.results||[]).map(row=>checked(row.payload_json));}
  if(process.env.NODE_ENV==="production")throw new Error("未来验证赛果存储暂不可用");
  const names=(await readdir(directory).catch(error=>{if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;})).filter(name=>recordName.test(name));
  return Promise.all(names.map(async name=>checked(await readFile(join(directory,name),"utf8"))));
}

export async function appendResearchResult(record:ResultObservation,lease?:ResearchWriterLease):Promise<ResultObservation>{
  if(!valid(record))throw new Error("首次观测赛果身份无效");
  const database=db();
  if(database){
    requireCloudLease(lease);
    const writer=lease!;
    const assertLease=async()=>{const rows=await database.prepare("SELECT fence FROM research_capture_leases WHERE scope_key = ? AND owner_token = ? AND fence = ? AND lease_until > unixepoch()").bind(writer.scope,writer.token,writer.fence).all<{fence:number}>();if(!rows.results?.length)throw cloudLeaseLost();};
    await assertLease();
    const existing=await database.prepare("SELECT payload_json FROM research_result_events WHERE fixture_key = ? AND outcome_hash = ?").bind(record.fixtureKey,record.outcomeHash).all<{payload_json:string}>();
    const previous=earliest((existing.results||[]).map(row=>checked(row.payload_json)).filter(row=>row.eventId===record.eventId));
    if(previous&&Date.parse(previous.firstObservedAt)<=Date.parse(record.firstObservedAt)){await assertLease();return previous;}
    // Two overlapping requests may persist in reverse order. Separate immutable
    // observation IDs retain the earlier read without updating an existing row.
    const observationId=`${record.eventId}-${record.contentHash}`;
    await database.prepare(`INSERT INTO research_result_events (id, fixture_key, first_observed_at, outcome_hash, payload_json, writer_scope, writer_token, writer_fence)
      SELECT ?, ?, ?, ?, ?, scope_key, owner_token, fence FROM research_capture_leases
      WHERE scope_key = ? AND owner_token = ? AND fence = ? AND lease_until > unixepoch() ON CONFLICT(id) DO NOTHING`)
      .bind(observationId,record.fixtureKey,record.firstObservedAt,record.outcomeHash,JSON.stringify(record),writer.scope,writer.token,writer.fence).run();
    await assertLease();
    const rows=await database.prepare("SELECT payload_json FROM research_result_events WHERE id = ?").bind(observationId).all<{payload_json:string}>();
    if(!rows.results?.length)throw new Error("首次观测赛果未持久化");
    const original=checked(rows.results[0].payload_json);
    if(original.fixtureKey!==record.fixtureKey||original.outcomeHash!==record.outcomeHash)throw new Error("赛果事件身份冲突");
    return original;
  }
  if(process.env.NODE_ENV==="production")throw new Error("未来验证赛果存储暂不可用");
  await mkdir(directory,{recursive:true});
  const names=(await readdir(directory)).filter(name=>recordName.test(name)&&name.startsWith(record.eventId));
  const previous=earliest(await Promise.all(names.map(async name=>checked(await readFile(join(directory,name),"utf8")))));
  if(previous&&Date.parse(previous.firstObservedAt)<=Date.parse(record.firstObservedAt))return previous;
  const path=join(directory,`${record.eventId}.${record.contentHash}.json`);
  try{await writeFile(path,JSON.stringify(record)+"\n",{flag:"wx"});return record;}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;const original=checked(await readFile(path,"utf8"));if(original.fixtureKey!==record.fixtureKey||original.outcomeHash!==record.outcomeHash)throw new Error("赛果事件身份冲突");return original;}
}
