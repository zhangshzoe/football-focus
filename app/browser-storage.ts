import {PREDICTION_STORAGE_KEY,PREDICTION_SNAPSHOT_STORAGE_KEY,type SavedPredictionSet} from "./prediction-config";

const DATABASE="ff-browser-data-v1",STORE="entries";
const pending=new Map<string,string>();
const warnings=new Map<string,string>();
const listeners=new Set<()=>void>();
const labels:Record<string,string>={
 [PREDICTION_STORAGE_KEY]:"当前预测",
 [PREDICTION_SNAPSHOT_STORAGE_KEY]:"历史预测",
 "ff-records":"投注记录",
 "ff-sporttery-official-cache-v1":"官方赛程缓存",
};
let warningSnapshot="";
export const subscribeStorageWarnings=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}};
export const getStorageWarning=()=>warningSnapshot;
export const getServerStorageWarning=()=>"";
export function reportStorageWarning(key:string,message:string){
 if(message)warnings.set(key,message);else warnings.delete(key);
 const next=Array.from(new Set(warnings.values())).join(" ");
 if(next!==warningSnapshot){warningSnapshot=next;listeners.forEach(listener=>listener())}
}
const failedSave=(key:string,error?:unknown)=>{
 const invalid=error instanceof SyntaxError||(error instanceof Error&&/旧预测历史格式/.test(error.message));
 reportStorageWarning(key,`${labels[key]||"浏览器数据"}暂未保存：${invalid?"旧缓存格式异常，已停止覆盖":"浏览器空间不足或存储被禁用"}。当前页面仍可使用，刷新可能丢失本次新结果；旧记录未删除。`);
};
const readLegacy=(key:string)=>window.localStorage.getItem(key)??undefined;

function openDatabase():Promise<IDBDatabase>{
 return new Promise((resolve,reject)=>{
  let settled=false;
  const timer=setTimeout(()=>fail(new Error("浏览器数据库打开超时")),5000);
  function fail(error:unknown){if(!settled){settled=true;clearTimeout(timer);reject(error)}}
  try{
   const request=window.indexedDB.open(DATABASE,1);
   request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(STORE))request.result.createObjectStore(STORE)};
   request.onerror=()=>fail(request.error);
   request.onblocked=()=>fail(new Error("浏览器数据库暂被占用"));
   request.onsuccess=()=>{
    if(settled){request.result.close();return}
    settled=true;clearTimeout(timer);
    request.result.onversionchange=()=>request.result.close();
    resolve(request.result);
   };
  }catch(error){fail(error)}
 });
}

// Keep read-modify-write inside one transaction, including importing a legacy value.
// Old localStorage entries are read-only: no blanket clear, eviction or data deletion.
async function transact(key:string,update?: (raw:string|undefined)=>string):Promise<string|undefined>{
 const database=await openDatabase();
 return new Promise((resolve,reject)=>{
  let result:string|undefined,cause:unknown;
  const transaction=database.transaction(STORE,update?"readwrite":"readonly");
  const timer=setTimeout(()=>{cause=new Error("浏览器数据库保存超时");transaction.abort()},15000);
  const finish=()=>{clearTimeout(timer);database.close()};
  transaction.oncomplete=()=>{finish();resolve(result)};
  transaction.onabort=()=>{finish();reject(cause||transaction.error||new Error("浏览器数据库事务失败"))};
  const store=transaction.objectStore(STORE),request=store.get(key);
  request.onsuccess=()=>{
   try{
    const raw=pending.get(key)??request.result??readLegacy(key);
    result=update?update(raw):raw;
    if(update)store.put(result,key);
   }catch(error){cause=error;transaction.abort()}
  };
 });
}

export async function readBrowserData<T>(key:string,fallback:T):Promise<T>{
 if(typeof window==="undefined")return fallback;
 try{
  const raw=pending.get(key)??await transact(key);
  return raw===undefined?fallback:JSON.parse(raw) as T;
 }catch{
  try{const raw=pending.get(key)??readLegacy(key);return raw===undefined?fallback:JSON.parse(raw) as T}catch{
   reportStorageWarning(key,`${labels[key]||"浏览器数据"}暂时无法读取，原有记录未修改。`);
   return fallback;
  }
 }
}

export async function updateBrowserData<T>(key:string,fallback:T,update:(value:T)=>T):Promise<boolean>{
 let next:string|undefined;
 const apply=(raw:string|undefined)=>{
  const value=update(raw===undefined?fallback:JSON.parse(raw) as T);
  next=JSON.stringify(value);
  if(next===undefined)throw new Error("无法序列化浏览器数据");
  return next;
 };
 try{
  await transact(key,apply);
  pending.delete(key);reportStorageWarning(key,"");
  return true;
 }catch(error){
  // Preserve the latest result in this page if persistence is unavailable.
  // A failed/corrupt legacy read never overwrites the original stored value.
  if(next===undefined)try{apply(pending.get(key)??readLegacy(key))}catch{/* 保留原始数据 */}
  if(next!==undefined)pending.set(key,next);
  failedSave(key,error);
  return false;
 }
}

export const writeBrowserData=<T,>(key:string,value:T)=>updateBrowserData<T>(key,value,()=>value);

export async function savePredictionSet(saved:SavedPredictionSet){
 const results=await Promise.all([
  writeBrowserData(PREDICTION_STORAGE_KEY,saved),
  updateBrowserData<SavedPredictionSet[]>(PREDICTION_SNAPSHOT_STORAGE_KEY,[],history=>{
   if(!Array.isArray(history))throw new Error("旧预测历史格式无效");
   if(history.some(item=>item.historyRecordId===saved.historyRecordId))return history;
   return [{...saved,scheduleLabel:"页面缓存（非定时快照）"},...history];
  }),
 ]);
 return results.every(Boolean);
}

// Small legacy records remain compatible; a quota error must not escape an effect.
export function writeLocalData(key:string,value:unknown){
 try{window.localStorage.setItem(key,JSON.stringify(value));reportStorageWarning(key,"");return true}catch(error){failedSave(key,error);return false}
}
