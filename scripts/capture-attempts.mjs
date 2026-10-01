import {mkdir,readFile,writeFile,open,unlink,rmdir} from "node:fs/promises";
import {join} from "node:path";
import {randomUUID} from "node:crypto";

/** One append-only execution fact. A failed source has an unknown denominator. */
export async function runCapture(meta,run,{root=process.cwd()}={}){
 if(!/^[a-z-]+$/.test(meta.kind||"")||! /^(?:\d{4}|poll)$/.test(meta.slot||""))throw new Error("采集任务身份无效");
 const startedAt=new Date().toISOString(),id=randomUUID(),date=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 const journal=join(root,"data/capture-attempts"),locks=join(root,"work/capture-locks");
 await mkdir(journal,{recursive:true});await mkdir(locks,{recursive:true});
 const lockPath=join(locks,`${date}-${meta.kind}-${meta.slot}.lock`);
 const guardPath=lockPath+".guard";
 const withGuard=async action=>{
  try{await mkdir(guardPath);}catch(error){if(error.code==="EEXIST")return {busy:true};throw error;}
  try{return await action();}finally{await rmdir(guardPath);}
 };
 let ownsLock=false;
 const audit={stage:"starting",officialManifest:null};
 const save=async result=>{
  const outcome=result.outcome||(result.status==="saved"?"saved":result.reason==="daily-snapshot-exists"||result.status==="exists"?"existing":result.reason==="no-eligible-plans"?"incomplete_evaluation":result.reason==="window-closed"?"late":"skipped");
  const record={...meta,...audit,...result,schemaVersion:1,recordType:"capture-attempt",immutable:true,attemptId:id,salesDate:date,startedAt,completedAt:new Date().toISOString(),outcome};
  if(record.reason)record.reason=String(record.reason).replace(/(token|secret|api[_-]?key|authorization)=\S+/gi,"$1=[redacted]").slice(0,1000);
  const name=`${date}_${meta.kind}_${meta.slot}_${id}.json`;
  try{await writeFile(join(journal,name),JSON.stringify(record)+"\n",{flag:"wx"});}catch(error){if(error.code!=="EEXIST")throw error;}
 };
 try{
  const acquired=await withGuard(async()=>{
   const existing=await readFile(lockPath,"utf8").catch(error=>{if(error.code==="ENOENT")return null;throw error;});
   if(existing){
    const owner=JSON.parse(existing);if(!Number.isInteger(owner.pid)||!owner.attemptId)throw new Error("采集锁身份损坏，需检查后恢复");
    let alive=true;try{process.kill(owner.pid,0);}catch(error){if(error.code==="ESRCH")alive=false;else throw error;}
    if(alive)return {busy:true};
    // Every acquisition/release obeys the guard, so stale recovery has no ABA race.
    await unlink(lockPath);
   }
   const file=await open(lockPath,"wx");try{await file.writeFile(JSON.stringify({pid:process.pid,startedAt,attemptId:id}));}finally{await file.close();}
   ownsLock=true;return {busy:false};
  });
  if(acquired.busy){const result={status:"skipped",reason:"capture-already-running"};await save(result);return result;}
  const result=await run(audit);await save(result||{status:"skipped",reason:"no-change"});return result;
 }catch(error){await save({status:"failed",outcome:error.code==="CAPTURE_LATE"?"late":"failed",reason:error.message||String(error),
  ...(["OFFICIAL_ACCESS_BLOCKED","OFFICIAL_MANIFEST_UNAVAILABLE","OFFICIAL_FETCH_FAILED"].includes(error.code)?{sourceCode:error.code,sourceState:error.sourceState||{manifestState:"unknown"}}:{})});throw error;}
 finally{if(ownsLock){
  let released=false;
  for(let attempt=0;attempt<20&&!released;attempt++){
   const state=await withGuard(async()=>{const owner=JSON.parse(await readFile(lockPath,"utf8"));if(owner.attemptId!==id)throw new Error("采集锁持有人变化，拒绝删除其他任务的锁");await unlink(lockPath);return {busy:false};});
   released=!state.busy;if(!released)await new Promise(resolve=>setTimeout(resolve,10));
  }
  if(!released)throw new Error("无法安全释放采集锁，请检查并发任务");
 }}
}
