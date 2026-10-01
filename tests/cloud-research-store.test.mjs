import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { cloudResearchStore } from "../app/cloud-research-store.js";
import { sqliteD1, researchDatabase } from "./helpers/cloud-sqlite-fixture.mjs";
import { appendCloudCaptureReceipt, recoverCloudCaptureReceipts } from "../app/cloud-capture-receipt.js";
import { researchHash, buildFirstObservedResult } from "../app/forward-validation.js";

async function fixtureStore({ claimed = true, path } = {}) {
  const sql = await researchDatabase(path);
  const database = sqliteD1(sql);
  const bytes = new Map(), puts = [];
  const objects = {
    async put(key, value, options) { puts.push({ key, options }); if (!bytes.has(key)) bytes.set(key, value); return {}; },
    async get(key) { return bytes.has(key) ? { text: async () => bytes.get(key) } : null; },
  };
  const base = cloudResearchStore({ database, objects });
  const claim = claimed ? await base.claim({ id: "fixture-run", requestHash: "a".repeat(64), startedAt: "2026-10-02T04:50:00.000Z" }) : null;
  return { store: claim ? base.withLease(claim.lease) : base, base, lease: claim?.lease, sql, bytes, puts, objects, database };
}
const record = (id = "evidence-1") => ({ id, type: "raw", observedAt: "2026-10-02T04:50:00.000Z", payload: { immutable: true, values: [1, 2, 3] } });

test("R2 complete object and D1 metadata are verified, create-only, and idempotent", async () => {
  const { store, sql, puts } = await fixtureStore();
  try {
    const saved = await store.append(record());
    assert.equal(saved.inserted, true); assert.deepEqual(saved.payload, record().payload);
    assert.equal((await store.append(record())).inserted, false); assert.equal(puts.length, 1);
    assert.equal(puts[0].options.onlyIf.get("If-None-Match"), "*");
    await assert.rejects(store.append({ ...record(), payload: { values: [9] } }), /禁止覆盖/);
    await assert.rejects(store.append({ ...record(), observedAt: "2026-10-02T05:00:00Z" }), /禁止覆盖/);
    assert.throws(() => sql.exec("UPDATE research_capture_records SET content_hash = 'bad'"), /immutable/);
    assert.throws(() => sql.exec("DELETE FROM research_capture_records"), /immutable/);
  } finally { sql.close(); }
});

test("missing or tampered object never becomes accepted evidence", async () => {
  const { store, sql, bytes } = await fixtureStore();
  try {
    await store.append(record()); const key = [...bytes.keys()][0];
    bytes.set(key, JSON.stringify({ values: [9] })); await assert.rejects(store.read("evidence-1"), /哈希/);
    bytes.delete(key); await assert.rejects(store.read("evidence-1"), /缺失/);
  } finally { sql.close(); }
});

test("pagination retains every immutable record and latest uses observed time", async () => {
  const { store, sql } = await fixtureStore();
  try {
    for (let i = 0; i < 57; i++) await store.append(record(`evidence-${String(i).padStart(3, "0")}`));
    assert.equal((await store.list("raw")).length, 57);
    assert.equal((await store.latest("raw")).id, "evidence-056");
    await assert.rejects(store.list("unknown"), /类型/);
  } finally { sql.close(); }
});

test("operational claim is separate from evidence and cannot reuse a different job", async () => {
  const { store, sql } = await fixtureStore({ claimed: false });
  try {
    const job = { id: "run-1", requestHash: "a".repeat(64), startedAt: record().observedAt };
    const claim = await store.claim(job), writer = store.withLease(claim.lease);
    assert.equal(claim.claimed, true);
    assert.equal((await store.claim(job)).status, "running");
    await assert.rejects(store.claim({ ...job, requestHash: "b".repeat(64) }), /冲突/);
    await writer.append({ ...record("attempt-run-1-1"), type: "source-attempt" });
    await writer.complete("run-1", { status: "failed", reason: "real source unavailable", attemptId: "attempt-run-1-1" });
    assert.equal((await store.claim(job)).result.reason, "real source unavailable");
    assert.equal((await store.list("raw")).length, 0);
  } finally { sql.close(); }
});

test("failed object write/readback never creates D1 evidence metadata", async () => {
  const { sql, database, lease } = await fixtureStore();
  try {
    const store = cloudResearchStore({ database, objects: { async put() {}, async get() { return null; } } }).withLease(lease);
    await assert.rejects(store.append(record()), /回读/);
    assert.equal(sql.prepare("SELECT COUNT(*) AS count FROM research_capture_records").get().count, 0);
  } finally { sql.close(); }
});

test("different requests compete atomically across two real SQLite worker connections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "football-lease-")), path = join(directory, "lease.sqlite");
  const sql = await researchDatabase(path), workers = [];
  try {
    const program = `const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{const {DatabaseSync}=await import('node:sqlite');
      const {sqliteD1}=await import(workerData.helper);const {cloudResearchStore}=await import(workerData.store);
      const sql=new DatabaseSync(workerData.path);const store=cloudResearchStore({database:sqliteD1(sql),objects:{async get(){return null},async put(){}}});
      parentPort.postMessage('ready');parentPort.once('message',async()=>{try{const result=await store.claim({id:workerData.id,requestHash:'a'.repeat(64),startedAt:'2000-01-01T00:00:00Z'});parentPort.postMessage(result)}catch(e){parentPort.postMessage({error:e.message})}finally{sql.close()}})})();`;
    const runs = ["parallel-a", "parallel-b"].map(id => {
      const worker = new Worker(program, { eval: true, workerData: { path, id, helper: new URL("./helpers/cloud-sqlite-fixture.mjs", import.meta.url).href, store: new URL("../app/cloud-research-store.js", import.meta.url).href } });
      workers.push(worker);
      let resolveReady;
      const ready = new Promise(resolve => { resolveReady = resolve; });
      const result = new Promise((resolve, reject) => { worker.on("error", reject); worker.on("message", data => data === "ready" ? resolveReady() : resolve(data)); });
      return { ready, result, worker };
    });
    await Promise.all(runs.map(run => run.ready)); runs.forEach(run => run.worker.postMessage("go"));
    const results = await Promise.all(runs.map(run => run.result));
    assert.equal(results.filter(result => result.claimed).length, 1); assert.ok(results.every(result => !result.error));
    assert.equal(sql.prepare("SELECT count(*) AS n FROM research_capture_runs").get().n, 1);
    const seconds = sql.prepare("SELECT lease_until - unixepoch() AS remaining FROM research_capture_leases").get().remaining;
    assert.ok(seconds > 110 && seconds <= 120, "database clock, not submitted year 2000, owns expiry");
  } finally { await Promise.all(workers.map(worker => worker.terminate())); sql.close(); await rm(directory, { recursive: true, force: true }); }
});

test("renewal, expired takeover and stale complete/release cannot affect the new owner", async () => {
  const { base, store, sql, lease } = await fixtureStore();
  try {
    await base.renew(lease);
    await store.append({ ...record("attempt-fixture-run-1"), type: "source-attempt" });
    await assert.rejects(base.renew({ ...lease, token: "wrong-owner-token" }), { code: "CLOUD_LEASE_LOST" });
    sql.exec("UPDATE research_capture_leases SET lease_until = unixepoch() - 1");
    await assert.rejects(base.renew(lease), { code: "CLOUD_LEASE_LOST" });
    const next = await base.claim({ id: "fixture-run", requestHash: "a".repeat(64), startedAt: "2026-10-02T05:00:00Z" });
    assert.equal(next.claimed, true); assert.equal(next.lease.fence, lease.fence + 1); assert.notEqual(next.lease.token, lease.token);
    const writer = base.withLease(next.lease);
    await writer.append({ ...record("attempt-fixture-run-2"), type: "source-attempt" });
    await assert.rejects(writer.complete("fixture-run", { status: "saved", attemptId: "attempt-fixture-run-1" }), /unverified/);
    await assert.rejects(writer.complete("fixture-run", { status: "saved", attemptId: "missing-attempt" }), /unverified/);
    await assert.rejects(store.complete("fixture-run", { status: "saved" }), { code: "CLOUD_LEASE_LOST" });
    await base.release(lease); await writer.assertLease();
    await writer.complete("fixture-run", { status: "failed", attemptId: "attempt-fixture-run-2" });
    assert.equal((await base.getRun("fixture-run")).result.attemptId, "attempt-fixture-run-2");
    assert.throws(() => sql.exec("DELETE FROM research_capture_leases"), /monotonic/);
  } finally { sql.close(); }
});

test("receipt persistence crossing a takeover cannot claim completion", async () => {
  const { base, store, sql, database, lease, objects } = await fixtureStore();
  try {
    const raw = { recordType: "raw-prediction-snapshot", immutable: true, snapshotId: "raw-receipt-race",
      capturedAt: "2026-10-02T12:50:00+08:00", scheduledAt: "2026-10-02T13:00:00+08:00",
      reports: [{ officialMatchId: "1", kickoffAt: "2026-10-02T13:30:00+08:00" }],
      officialMatches: [{ officialMatchId: "1", matchStatus: "Selling", marketEligibility: { HAD: { qualification: "qualified", salesStatus: "Selling", cutoffAt: "2026-10-02T13:20:00+08:00" } } }] };
    await store.append({ id: raw.snapshotId, type: "raw", observedAt: raw.capturedAt, payload: raw });
    const interrupted = cloudResearchStore({ database, objects: { ...objects, async put(...args) {
      await objects.put(...args); sql.exec("UPDATE research_capture_leases SET lease_until = unixepoch() - 1");
      await base.claim({ id: "receipt-takeover", requestHash: "b".repeat(64), startedAt: raw.capturedAt });
    } } }).withLease(lease);
    await assert.rejects(appendCloudCaptureReceipt(interrupted, raw, "2026-10-02T12:51:00+08:00"), { code: "CLOUD_LEASE_LOST" });
    assert.equal(await base.read(`raw-receipt-${raw.snapshotId}`), null);
    assert.equal((await base.read(raw.snapshotId)).hash, researchHash(raw));
  } finally { sql.close(); }
});

test("actual result writer is fenced after its precheck and accepted results cannot be rewritten", async () => {
  const { base, sql, database, lease } = await fixtureStore();
  const fixture = { officialMatchId: "100001", salesDate: "2026-09-25", kickoffAt: "2026-09-25T18:00:00Z", home: "Home FC", away: "Away FC", league: "Test" };
  const built = buildFirstObservedResult({ ...fixture, status: "settled", fullScore: "2:1", hadResult: "胜", totalGoalsResult: "3" }, [fixture], "2026-09-25T21:00:00Z", "https://cp.zgzcw.com/dc/getKaijiangFootBall.action");
  assert.equal(built.status, "verified");
  let interrupt = true, next;
  const guardedDatabase = { ...database, prepare(query) {
    const prepared = database.prepare(query);
    return { bind(...values) { const bound = prepared.bind(...values); return { ...bound, async run() {
      if (interrupt && query.startsWith("INSERT INTO research_result_events")) {
        interrupt = false; sql.exec("UPDATE research_capture_leases SET lease_until = unixepoch() - 1");
        next = await base.claim({ id: "result-takeover", requestHash: "b".repeat(64), startedAt: "2026-10-02T05:00:00Z" });
      }
      return bound.run();
    } }; } };
  } };
  const key = `__football_result_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const previousEnvironment = process.env.NODE_ENV;
  try {
    globalThis[key] = { DB: guardedDatabase }; process.env.NODE_ENV = "production";
    const typescript = createRequire(import.meta.url)("typescript");
    let source = typescript.transpileModule(await readFile(new URL("../app/research-result-store.ts", import.meta.url), "utf8"), { compilerOptions: { module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2022 } }).outputText;
    source = source.replace(/import \{ env \} from "cloudflare:workers";/, `const env=globalThis[${JSON.stringify(key)}];`)
      .replace(/from "\.\/([^"]+)"/g, (_, file) => `from ${JSON.stringify(new URL(`../app/${file}`, import.meta.url).href)}`);
    const resultStore = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    await assert.rejects(resultStore.appendResearchResult(built.record, lease), { code: "CLOUD_LEASE_LOST" });
    assert.equal(sql.prepare("SELECT count(*) AS n FROM research_result_events").get().n, 0);
    assert.deepEqual(await resultStore.appendResearchResult(built.record, next.lease), built.record);
    assert.throws(() => sql.exec("UPDATE research_result_events SET payload_json = '{}'"), /immutable/);
    assert.throws(() => sql.exec("DELETE FROM research_result_events"), /immutable/);
  } finally { delete globalThis[key]; if (previousEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnvironment; sql.close(); }
});

test("lease expiry during R2 persistence cannot create evidence of any type", async () => {
  for (const type of ["raw", "purchase", "candidate", "official-universe", "source-attempt", "replay-index"]) {
    const { base, sql, database, lease, objects, bytes } = await fixtureStore();
    try {
      const writer = cloudResearchStore({ database, objects: { ...objects, async put(...args) {
        await objects.put(...args); sql.exec("UPDATE research_capture_leases SET lease_until = unixepoch() - 1");
        await base.claim({ id: "replacement", requestHash: "b".repeat(64), startedAt: "2026-10-02T04:51:00Z" });
      } } }).withLease(lease);
      await assert.rejects(writer.append({ ...record(), type }), { code: "CLOUD_LEASE_LOST" });
      assert.equal(sql.prepare("SELECT count(*) AS n FROM research_capture_records").get().n, 0);
      assert.equal(bytes.size, 1, "orphan bytes do not become evidence");
    } finally { sql.close(); }
  }
});

test("active raw is not recovered; takeover receipts are honest and stale raw cannot get a normal receipt", async () => {
  const { base, store, sql, lease } = await fixtureStore();
  const raw = { recordType: "raw-prediction-snapshot", immutable: true, snapshotId: "raw-orphan",
    capturedAt: "2026-10-02T12:50:00+08:00", scheduledAt: "2026-10-02T13:00:00+08:00",
    reports: [{ officialMatchId: "1", kickoffAt: "2026-10-02T13:30:00+08:00" }],
    officialMatches: [{ officialMatchId: "1", matchStatus: "Selling", marketEligibility: { HAD: { qualification: "qualified", salesStatus: "Selling", cutoffAt: "2026-10-02T13:20:00+08:00" } } }] };
  try {
    await store.append({ id: raw.snapshotId, type: "raw", observedAt: raw.capturedAt, payload: raw });
    assert.equal((await recoverCloudCaptureReceipts(store, () => "2026-10-02T12:51:00+08:00")).length, 0);
    sql.exec("UPDATE research_capture_leases SET lease_until = unixepoch() - 1");
    const next = await base.claim({ id: "recover-run", requestHash: "b".repeat(64), startedAt: "2026-10-02T04:51:00Z" });
    const writer = base.withLease(next.lease);
    await assert.rejects(appendCloudCaptureReceipt(writer, raw, "2026-10-02T12:51:00+08:00"), { code: "CLOUD_LEASE_LOST" });
    const recovered = await recoverCloudCaptureReceipts(writer, () => "2026-10-02T12:52:00+08:00");
    assert.equal(recovered.length, 1); assert.equal(recovered[0].includedInStrictEvaluation, false);
    assert.equal((await base.read(`raw-receipt-${raw.snapshotId}`)).payload.recovered, true);
    assert.equal((await base.read(raw.snapshotId)).hash, researchHash(raw));
    await assert.rejects(store.append(record("stale-raw")), { code: "CLOUD_LEASE_LOST" });
    await base.release(lease); await writer.assertLease();
    assert.throws(() => sql.prepare("INSERT INTO research_result_events (id,fixture_key,first_observed_at,outcome_hash,payload_json,writer_scope,writer_token,writer_fence) VALUES (?,?,?,?,?,?,?,?)").run("stale-result", "f", raw.capturedAt, "h", "{}", lease.scope, lease.token, lease.fence), /expired/);
    assert.throws(() => sql.exec("INSERT INTO research_capture_records (id,record_type,observed_at,content_hash,object_key) VALUES ('old-writer','raw','t','h','key')"), /expired/);
  } finally { sql.close(); }
});
