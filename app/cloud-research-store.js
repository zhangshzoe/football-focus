import { researchHash } from "./forward-validation.js";
import { CLOUD_WRITER_SCOPE, CLOUD_LEASE_SECONDS, requireCloudLease, cloudLeaseLost } from "./cloud-writer-lease.js";

const RECORD_TYPES = new Set([
  "official-universe", "source-attempt", "raw", "candidate", "receipt", "purchase", "replay-index",
]);
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_.:-]{1,180}$/.test(id);
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])])) : value;
const date = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

// D1 holds searchable metadata; complete inputs/distributions live in R2.
// Runtime never creates schema, updates evidence, or falls back to browser memory.
export function cloudResearchStore({ database, objects }) {
  if (!database?.prepare || !objects?.get || !objects?.put)
    throw new Error("线上采集存储暂不可用");
  const statement = (sql, values = []) => database.prepare(sql).bind(...values);
  const runRow = (id) => statement("SELECT id, request_hash, started_at, status, result_json, owner_token, fence FROM research_capture_runs WHERE id = ?", [id]).first();
  const getRun = async (id) => {
    if (!validId(id)) throw new Error("采集任务 ID 无效");
    const row = await runRow(id);
    return row ? { status: row.status, result: row.result_json ? JSON.parse(row.result_json) : null } : null;
  };
  const assertLease = async (lease) => {
    requireCloudLease(lease);
    const row = await statement("SELECT fence FROM research_capture_leases WHERE scope_key = ? AND owner_token = ? AND fence = ? AND lease_until > unixepoch()", [lease.scope, lease.token, lease.fence]).first();
    if (!row) throw cloudLeaseLost();
  };
  const renew = async (lease) => {
    requireCloudLease(lease);
    const row = await statement("UPDATE research_capture_leases SET lease_until = unixepoch() + ? WHERE scope_key = ? AND owner_token = ? AND fence = ? AND lease_until > unixepoch() RETURNING fence", [CLOUD_LEASE_SECONDS, lease.scope, lease.token, lease.fence]).first();
    if (!row) throw cloudLeaseLost();
  };
  const release = async (lease) => {
    requireCloudLease(lease);
    await statement("UPDATE research_capture_leases SET lease_until = 0 WHERE scope_key = ? AND owner_token = ? AND fence = ?", [lease.scope, lease.token, lease.fence]).run();
  };
  const read = async (id) => {
    if (!validId(id)) throw new Error("采集记录 ID 无效");
    const row = await statement("SELECT * FROM research_capture_records WHERE id = ?", [id]).first();
    if (!row) return null;
    const object = await objects.get(row.object_key);
    if (!object) throw new Error("采集记录的完整内容缺失");
    const payload = JSON.parse(await object.text());
    if (researchHash(payload) !== row.content_hash) throw new Error("采集记录回读哈希不一致");
    return { id: row.id, type: row.record_type, observedAt: row.observed_at, hash: row.content_hash, payload,
      writer: row.writer_fence == null ? null : { scope: row.writer_scope, token: row.writer_token, fence: row.writer_fence },
      parentId: row.parent_id, parentHash: row.parent_hash, recovered: row.receipt_recovered == null ? null : row.receipt_recovered === 1 };
  };
  const append = async ({ id, type, observedAt, payload }, lease) => {
    await assertLease(lease);
    if (!validId(id) || !RECORD_TYPES.has(type) || !date(observedAt) || !payload || typeof payload !== "object")
      throw new Error("不可变采集记录身份无效");
    const hash = researchHash(payload), existing = await read(id);
    if (existing) {
      if (existing.hash !== hash || existing.type !== type || existing.observedAt !== observedAt)
        throw new Error("已有不可变记录冲突，禁止覆盖");
      await assertLease(lease);
      return { ...existing, inserted: false };
    }
    let parentId = null, parentHash = null, recovered = null;
    if (type === "receipt") {
      const rawReceipt = payload.recordType === "cloud-raw-receipt";
      const forwardReceipt = payload.recordType === "forward-capture-receipt";
      if ((!rawReceipt && !forwardReceipt) || (rawReceipt && typeof payload.recovered !== "boolean")) throw new Error("完成凭证缺少可核验原始记录");
      parentId = rawReceipt ? payload.snapshotId : payload.captureId;
      const parent = await read(parentId);
      if (!parent || (rawReceipt ? parent.hash !== payload.rawHash || !["raw", "purchase"].includes(parent.type)
        : parent.type !== "candidate" || parent.payload.contentHash !== payload.contentHash)) throw new Error("完成凭证的原始记录哈希不一致");
      recovered = rawReceipt && payload.recovered ? 1 : 0;
      const sameOwner = parent.writer?.scope === lease.scope && parent.writer?.token === lease.token && parent.writer?.fence === lease.fence;
      if (recovered ? parent.writer && !(parent.writer.scope === lease.scope && parent.writer.fence < lease.fence) : !sameOwner) throw cloudLeaseLost();
      parentHash = parent.hash;
    }
    const bytes = JSON.stringify(canonical(payload));
    if (new TextEncoder().encode(bytes).length > 16 * 1024 * 1024)
      throw new Error("单条采集记录超过安全容量；未截断或保存不完整内容");
    const objectKey = `research/${type}/${id}/${hash}.json`;
    // Content-addressed keys and create-only writes keep concurrent requests
    // from overwriting an existing object. Orphan objects are never evidence.
    await objects.put(objectKey, bytes, { onlyIf: new Headers({ "If-None-Match": "*" }), httpMetadata: { contentType: "application/json" } });
    const object = await objects.get(objectKey);
    if (!object || researchHash(JSON.parse(await object.text())) !== hash)
      throw new Error("完整采集内容未通过持久化回读核验");
    // Recheck in the INSERT itself: the lease may expire during the R2 await.
    const result = await statement(`INSERT INTO research_capture_records
      (id, record_type, observed_at, content_hash, object_key, writer_scope, writer_token, writer_fence, parent_id, parent_hash, receipt_recovered)
      SELECT ?, ?, ?, ?, ?, scope_key, owner_token, fence, ?, ?, ? FROM research_capture_leases
      WHERE scope_key = ? AND owner_token = ? AND fence = ? AND lease_until > unixepoch()
      AND (? IS NULL OR EXISTS (SELECT 1 FROM research_capture_records p WHERE p.id = ? AND p.content_hash = ?
        AND ((? = 0 AND p.writer_scope = scope_key AND p.writer_token = owner_token AND p.writer_fence = fence)
          OR (? = 1 AND (p.writer_fence IS NULL OR (p.writer_scope = scope_key AND p.writer_fence < fence))))))
      ON CONFLICT(id) DO NOTHING`, [id, type, observedAt, hash, objectKey, parentId, parentHash, recovered,
      lease.scope, lease.token, lease.fence, parentId, parentId, parentHash, recovered, recovered]).run();
    await assertLease(lease);
    const saved = await read(id);
    if (!saved || saved.hash !== hash || saved.type !== type || saved.observedAt !== observedAt)
      throw new Error("采集元数据写入失败或发生不可变身份冲突");
    return { ...saved, inserted: Number(result.meta?.changes || 0) === 1 };
  };
  const scan = async function* (type) {
    if (!RECORD_TYPES.has(type)) throw new Error("采集记录类型无效");
    let at = "", id = "";
    for (;;) {
      const rows = await statement("SELECT id, observed_at FROM research_capture_records WHERE record_type = ? AND (observed_at > ? OR (observed_at = ? AND id > ?)) ORDER BY observed_at ASC, id ASC LIMIT 50", [type, at, at, id]).all();
      if (!rows.results?.length) break;
      // One complete record at a time bounds Worker peak memory/R2 connections.
      for (const row of rows.results) { yield await read(row.id); at = row.observed_at; id = row.id; }
    }
  };
  const list = async (type) => {
    const records = [];
    let bytes = 0;
    for await (const record of scan(type)) {
      bytes += new TextEncoder().encode(JSON.stringify(record)).length;
      if (bytes > 24 * 1024 * 1024) throw new Error("采集读取超过单次安全容量；请使用逐条读取，未返回截断证据");
      records.push(record);
    }
    return records;
  };
  const latest = async (type) => {
    if (!RECORD_TYPES.has(type)) throw new Error("采集记录类型无效");
    const row = await statement("SELECT id FROM research_capture_records WHERE record_type = ? ORDER BY observed_at DESC, id DESC LIMIT 1", [type]).first();
    return row ? read(row.id) : null;
  };
  const claim = async ({ id, requestHash, startedAt }) => {
    if (!database.batch) throw new Error("线上采集存储缺少原子任务领取能力");
    if (!validId(id) || !/^[a-f0-9]{64}$/.test(requestHash) || !date(startedAt)) throw new Error("采集任务身份无效");
    const token = crypto.randomUUID();
    await database.batch([
      statement(`INSERT INTO research_capture_leases (scope_key, owner_token, fence, lease_until)
        SELECT ?, ?, 1, unixepoch() + ? WHERE NOT EXISTS
          (SELECT 1 FROM research_capture_runs WHERE id = ? AND (request_hash != ? OR status = 'complete'))
        ON CONFLICT(scope_key) DO UPDATE SET owner_token = excluded.owner_token,
          fence = research_capture_leases.fence + 1, lease_until = excluded.lease_until
        WHERE research_capture_leases.lease_until <= unixepoch()`, [CLOUD_WRITER_SCOPE, token, CLOUD_LEASE_SECONDS, id, requestHash]),
      statement(`INSERT INTO research_capture_runs (id, request_hash, started_at, status, owner_token, fence)
        SELECT ?, ?, ?, 'running', owner_token, fence FROM research_capture_leases
        WHERE scope_key = ? AND owner_token = ? AND lease_until > unixepoch()
        ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, owner_token = excluded.owner_token, fence = excluded.fence
        WHERE research_capture_runs.status = 'running' AND research_capture_runs.request_hash = excluded.request_hash`,
      [id, requestHash, startedAt, CLOUD_WRITER_SCOPE, token]),
    ]);
    const run = await runRow(id);
    if (run && run.request_hash !== requestHash) throw new Error("采集任务 ID 与请求内容冲突");
    if (run?.status === "complete") return { claimed: false, status: "complete", result: JSON.parse(run.result_json) };
    if (!run || run.owner_token !== token) return { claimed: false, status: "running", result: null };
    const lease = { scope: CLOUD_WRITER_SCOPE, token, fence: run.fence };
    await assertLease(lease);
    return { claimed: true, status: "running", lease };
  };
  const complete = async (id, result, lease) => {
    requireCloudLease(lease);
    if (!validId(id)) throw new Error("采集任务 ID 无效");
    const json = JSON.stringify(result);
    const updated = await statement(`UPDATE research_capture_runs SET status = 'complete', result_json = ?
      WHERE id = ? AND status = 'running' AND owner_token = ? AND fence = ?
      AND EXISTS (SELECT 1 FROM research_capture_leases WHERE scope_key = ? AND owner_token = ? AND fence = ? AND lease_until > unixepoch()) RETURNING id`,
    [json, id, lease.token, lease.fence, lease.scope, lease.token, lease.fence]).first();
    if (!updated) throw cloudLeaseLost();
    const run = await runRow(id);
    if (run?.status !== "complete" || run.result_json !== json) throw new Error("采集执行结果回读失败");
    return result;
  };
  const withLease = (lease) => {
    requireCloudLease(lease);
    return { read, scan, list, latest, lease, assertLease: () => assertLease(lease),
      append: (record) => append(record, lease), complete: (id, result) => complete(id, result, lease),
      canRecover: (record) => !record.writer || (record.writer.scope === lease.scope && record.writer.fence < lease.fence) };
  };
  return { read, scan, list, latest, claim, getRun, withLease, renew, release };
}
