import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import ts from "typescript";
import {IDBFactory,IDBObjectStore} from "fake-indexeddb";

const TODAY="ff-today-predictions-v3",HISTORY="ff-prediction-snapshots-v1";
const compile=source=>`data:text/javascript;base64,${Buffer.from(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString("base64")}`;
let moduleId=0;
async function loadStorage(){
 const config=compile(await readFile(new URL("../app/prediction-config.ts",import.meta.url),"utf8"));
 const source=(await readFile(new URL("../app/browser-storage.ts",import.meta.url),"utf8")).replace('from "./prediction-config"',`from ${JSON.stringify(config)}`);
 return import(`${compile(source)}#storage-test-${++moduleId}`);
}
function environment(entries=[],indexedDB=new IDBFactory()){
 const previous=Object.getOwnPropertyDescriptor(globalThis,"window"),values=new Map(entries);
 let writes=0;
 const localStorage={getItem:key=>values.get(key)??null,setItem(){writes++;throw new DOMException("Storage quota exceeded","QuotaExceededError")},removeItem(){throw new Error("Must not delete old data")},clear(){throw new Error("Must not clear user data")}};
 Object.defineProperty(globalThis,"window",{configurable:true,value:{localStorage,indexedDB}});
 return {values,get writes(){return writes},restore(){if(previous)Object.defineProperty(globalThis,"window",previous);else delete globalThis.window}};
}
const snapshot=id=>({historyRecordId:id,predictionId:`prediction-${id}`,date:"2026-09-14",sourceFetchedAt:"2026-09-14T08:00:00Z",matches:[{id,probability:16}]});

test("full localStorage is preserved while forecasts and all legacy history survive database reload",async()=>{
 const old=Array.from({length:125},(_,i)=>snapshot(`old-${i}`));
 const entries=[[HISTORY,JSON.stringify(old)],[TODAY,JSON.stringify(old[0])],["ff-records",'["投注原始记录"]'],["unrelated","untouched"]];
 const env=environment(entries);
 try{
  const storage=await loadStorage(),current=snapshot("new");
  assert.deepEqual(await storage.readBrowserData(TODAY,null),old[0]);
  assert.equal(await storage.savePredictionSet(current),true);
  assert.equal(await storage.savePredictionSet(current),true);
  const reloaded=await loadStorage();
  assert.deepEqual(await reloaded.readBrowserData(TODAY,null),current);
  const history=await reloaded.readBrowserData(HISTORY,[]);
  assert.equal(history.length,126);
  assert.deepEqual(history.slice(1),old);
  assert.deepEqual([...env.values],entries);
  assert.equal(env.writes,0,"Forecast persistence must not consume localStorage quota");
  assert.equal(storage.getStorageWarning(),"");
 }finally{env.restore()}
});

test("concurrent prediction saves preserve every independent history version",async()=>{
 const env=environment([[HISTORY,JSON.stringify([snapshot("legacy")])]]);
 try{
  const storage=await loadStorage();
  const sets=Array.from({length:8},(_,i)=>snapshot(`parallel-${i}`));
  assert.ok((await Promise.all(sets.map(value=>storage.savePredictionSet(value)))).every(Boolean));
  const history=await storage.readBrowserData(HISTORY,[]);
  assert.equal(new Set(history.map(item=>item.historyRecordId)).size,9);
  for(const item of sets)assert.ok(history.some(saved=>saved.historyRecordId===item.historyRecordId));
 }finally{env.restore()}
});

test("unavailable storage returns an explicit warning and keeps the new result in the current page",async()=>{
 const old=snapshot("old"),entries=[[TODAY,JSON.stringify(old)],[HISTORY,JSON.stringify([old])]];
 const env=environment(entries,{open(){throw new DOMException("Storage disabled","SecurityError")}});
 try{
  const storage=await loadStorage(),current=snapshot("unsaved");
  assert.equal(await storage.savePredictionSet(current),false);
  assert.deepEqual(await storage.readBrowserData(TODAY,null),current);
  assert.match(storage.getStorageWarning(),/暂未保存/);
  assert.match(storage.getStorageWarning(),/刷新可能丢失/);
  assert.deepEqual([...env.values],entries);
  // A fresh page cannot claim that an in-memory-only result was persisted.
  assert.deepEqual(await (await loadStorage()).readBrowserData(TODAY,null),old);
 }finally{env.restore()}
});

test("an aborted database write does not overwrite the last successfully saved prediction",async()=>{
 const env=environment(),storage=await loadStorage(),originalPut=IDBObjectStore.prototype.put;
 try{
  const old=snapshot("committed"),current=snapshot("quota-failed");
  assert.equal(await storage.savePredictionSet(old),true);
  IDBObjectStore.prototype.put=function(){throw new DOMException("Database quota exceeded","QuotaExceededError")};
  assert.equal(await storage.savePredictionSet(current),false);
  assert.match(storage.getStorageWarning(),/暂未保存/);
  IDBObjectStore.prototype.put=originalPut;
  const reloaded=await loadStorage();
  assert.deepEqual(await reloaded.readBrowserData(TODAY,null),old);
  assert.equal((await reloaded.readBrowserData(HISTORY,[])).length,1);
  assert.equal(await storage.savePredictionSet(current),true);
  assert.equal(storage.getStorageWarning(),"");
  assert.equal((await storage.readBrowserData(HISTORY,[])).length,2);
 }finally{IDBObjectStore.prototype.put=originalPut;env.restore()}
});

test("corrupt legacy history and betting records are not cleared or silently replaced",async()=>{
 const env=environment([[HISTORY,"invalid JSON"],["ff-records",'["original"]']]);
 try{
  const storage=await loadStorage();
  assert.equal(await storage.savePredictionSet(snapshot("new")),false);
  assert.equal(env.values.get(HISTORY),"invalid JSON");
  assert.equal(storage.writeLocalData("ff-records",["new"]),false);
  assert.equal(env.values.get("ff-records"),'["original"]');
  assert.match(storage.getStorageWarning(),/投注记录暂未保存/);
 }finally{env.restore()}
});
