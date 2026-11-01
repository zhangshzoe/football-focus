// Staged persistence foundation. Production writes are intentionally unavailable.
// D1 is the authority for visibility; content-addressed R2 orphans are not records.
export function authorizeOwner(headers, operatorEmail) {
  const id=headers.get('oai-authenticated-user-id');
  const email=headers.get('oai-authenticated-user-email');
  if (!id || !email || !operatorEmail || email.trim().toLowerCase()!==operatorEmail.trim().toLowerCase()) throw new Error('OWNER_IDENTITY_REQUIRED');
  return id;
}
export function assertTestNamespace(namespace) {
  if (!/^test-[a-z0-9][a-z0-9-]{0,63}$/.test(namespace||'')) throw new Error('PRODUCTION_WRITES_DISABLED');
}
export async function sha256(text) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
const safeId=value=>typeof value==='string' && /^[a-zA-Z0-9_.|:-]{1,180}$/.test(value);
export class HandoffStore {
  constructor(db,bucket) {if(!db||!bucket)throw new Error('PERSISTENT_BINDINGS_REQUIRED');this.db=db;this.bucket=bucket;}
  async batch(key) {return this.db.prepare('SELECT * FROM cloud_handoff_batches WHERE key = ?').bind(key).first();}
  async claim({namespace,key,now=new Date().toISOString()}) {
    assertTestNamespace(namespace);
    if(!safeId(key)||!key.startsWith(namespace+'|'))throw new Error('INVALID_BATCH_KEY');
    const token=crypto.randomUUID();
    // No expired-lease takeover: uncertain/crashed running batches remain blocked
    // for explicit reconciliation. This prevents automatic recapture after failure.
    await this.db.prepare("INSERT INTO cloud_handoff_batches (key,namespace,status,owner_token,started_at) SELECT ?,?,'running',?,? WHERE NOT EXISTS (SELECT 1 FROM cloud_handoff_batches WHERE namespace = ? AND status = 'running') ON CONFLICT(key) DO NOTHING").bind(key,namespace,token,now,namespace).run();
    const row=await this.batch(key);
    return {claimed:row?.owner_token===token,key,token:row?.owner_token===token?token:null,status:row?.status||'writer-busy'};
  }
  async write({namespace,key,token,kind,id,raw,observedAt,metadata={}}) {
    assertTestNamespace(namespace);
    if(!safeId(kind)||!safeId(id)||typeof raw!=='string'||new TextEncoder().encode(raw).length>2*1024*1024||!Number.isFinite(Date.parse(observedAt)))throw new Error('INVALID_EVIDENCE');
    const batch=await this.batch(key);
    if(batch?.namespace!==namespace||batch.status!=='running'||batch.owner_token!==token)throw new Error('WRITER_FENCE_REJECTED');
    const hash=await sha256(raw);
    const prior=await this.get(namespace,kind,id);
    if(prior){if(prior.content_hash!==hash)throw new Error('IMMUTABLE_HASH_CONFLICT');return prior;}
    const objectKey=`cloud-handoff/${namespace}/sha256/${hash}`;
    await this.bucket.put(objectKey,raw,{onlyIf:{etagDoesNotMatch:'*'},customMetadata:{sha256:hash}});
    const persisted=await this.bucket.get(objectKey);
    if(!persisted||await sha256(await persisted.text())!==hash)throw new Error('RAW_READBACK_HASH_MISMATCH');
    await this.db.prepare("INSERT INTO cloud_handoff_records (namespace,record_kind,record_id,content_hash,object_key,observed_at,metadata_json) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM cloud_handoff_batches WHERE key = ? AND namespace = ? AND status = 'running' AND owner_token = ?) ON CONFLICT(namespace,record_kind,record_id) DO NOTHING").bind(namespace,kind,id,hash,objectKey,observedAt,JSON.stringify(metadata),key,namespace,token).run();
    const result=await this.get(namespace,kind,id);
    if(!result)throw new Error('WRITER_FENCE_REJECTED');
    if(result.content_hash!==hash)throw new Error('IMMUTABLE_HASH_CONFLICT');
    return result;
  }
  async get(namespace,kind,id) {
    const row=await this.db.prepare('SELECT * FROM cloud_handoff_records WHERE namespace = ? AND record_kind = ? AND record_id = ?').bind(namespace,kind,id).first();
    if(!row)return null;
    const object=await this.bucket.get(row.object_key);
    if(!object)throw new Error('MISSING_RAW_NOT_EMPTY_HISTORY');
    const raw=await object.text();
    if(await sha256(raw)!==row.content_hash)throw new Error('RAW_READBACK_HASH_MISMATCH');
    return {...row,raw};
  }
  async finish({namespace,key,token,status,failureCode=null}) {
    assertTestNamespace(namespace);
    if(!['complete','failed','missed'].includes(status))throw new Error('INVALID_TERMINAL_STATE');
    await this.db.prepare("UPDATE cloud_handoff_batches SET status = ?, completed_at = ?, failure_code = ? WHERE key = ? AND namespace = ? AND owner_token = ? AND status = 'running'").bind(status,new Date().toISOString(),failureCode,key,namespace,token).run();
    const row=await this.batch(key);
    if(row?.namespace!==namespace||row.owner_token!==token||row.status!==status)throw new Error('WRITER_FENCE_REJECTED');
    return row;
  }
}

// Projection only: caller must pass verified per-record deltas, never replace a
// whole online index. Unknown fields remain intact; existing IDs are immutable.
export function mergeVerifiedRecords(baseline,records) {
  if(!baseline||typeof baseline!=='object'||Array.isArray(baseline))throw new Error('MISSING_BASELINE_NOT_EMPTY_HISTORY');
  const merged=structuredClone(baseline);
  for(const {kind,id,payload} of records) {
    if(!['snapshots','purchasePlanSnapshots','captureAttempts','captureEvents','dailyBestDecisions','resultCache'].includes(kind))throw new Error('UNSUPPORTED_RECORD_KIND');
    if(kind==='resultCache') {
      merged.resultCache??={};
      if(Object.hasOwn(merged.resultCache,id)&&JSON.stringify(merged.resultCache[id])!==JSON.stringify(payload))throw new Error('EXISTING_RECORD_CONFLICT');
      Object.defineProperty(merged.resultCache,id,{value:structuredClone(payload),enumerable:true,writable:true,configurable:true});
    } else {
      if(merged[kind]!==undefined&&!Array.isArray(merged[kind]))throw new Error('INVALID_BASELINE');
      merged[kind]??=[];
      const key=item=>String(item.snapshotId||item.recordId||item.id||'');
      if(key(payload)!==id)throw new Error('RECORD_ID_MISMATCH');
      const prior=merged[kind].find(item=>key(item)===id);
      if(prior&&JSON.stringify(prior)!==JSON.stringify(payload))throw new Error('EXISTING_RECORD_CONFLICT');
      if(!prior)merged[kind].push(structuredClone(payload));
    }
  }
  return merged;
}

// Live site reader: never includes a test namespace or replaces baseline history.
// No records is distinct from a missing/unreadable table/object: the latter throws.
export async function readProductionProjection(db,bucket,baseline) {
  if(!db||!bucket)return {index:baseline,status:'bindings-unavailable-baseline-preserved'};
  const result=await db.prepare("SELECT record_kind,record_id FROM cloud_handoff_records WHERE namespace = 'production' ORDER BY record_kind,record_id LIMIT 1001").all();
  const rows=result.results||[];
  if(rows.length>1000)throw new Error('PROJECTION_PAGINATION_REQUIRED_NO_PARTIAL_HISTORY');
  const store=new HandoffStore(db,bucket),records=[];
  for(const row of rows){
    const verified=await store.get('production',row.record_kind,row.record_id);
    if(!verified)throw new Error('MISSING_RAW_NOT_EMPTY_HISTORY');
    records.push({kind:row.record_kind,id:row.record_id,payload:JSON.parse(verified.raw)});
  }
  return {index:mergeVerifiedRecords(baseline,records),status:rows.length?'verified-d1-r2+bundle':'d1-empty-baseline-preserved'};
}

// Availability fallback keeps old displayed history, while loudly marking that
// newer durable history could not be verified. Never report this as ready/synced.
export async function readProductionProjectionForDisplay(db,bucket,baseline) {
  try {return {...await readProductionProjection(db,bucket,baseline),error:null};}
  catch {return {index:baseline,status:'degraded-baseline-only',error:'PERSISTENT_HISTORY_UNVERIFIED'};}
}
