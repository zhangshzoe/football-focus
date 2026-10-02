import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { Worker } from "node:worker_threads";
import { sqliteD1 } from "./helpers/cloud-sqlite-fixture.mjs";
import { createPredictionJobStore, predictionJobSchemaSql } from "../app/prediction-job-store.js";
import {
  createPredictionUnitRuntime,
  predictionUnitDeadline,
} from "../app/prediction-unit-runtime.js";
import { computePredictionUnit } from "../app/prediction-computation.js";
import { PREDICTION_PIPELINE_VERSION } from "../app/prediction-model.js";

// Synthetic inputs live only in test memory or an isolated OS temporary folder.
const codeIdentity = {
  schemaVersion: 1,
  sourceHash: "a".repeat(64),
  files: { "fixture-compute.js": "b".repeat(64) },
};
function prepared(now = Date.now()) {
  const fetchedAt = new Date(now - 1000).toISOString(),
    decisionAt = new Date(now).toISOString();
  const kickoffAt = new Date(now + 3600000).toISOString();
  const salesDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
    new Date(now),
  );
  const match = {
    officialMatchId: "fixture-home-away",
    salesDate,
    kickoffAt,
    isMock: false,
    home: "fixture-home",
    away: "fixture-away",
    odds: [2, 3.2, 3.8],
    marketOdds: {
      让球胜平负: [4, 3.6, 1.8],
      总进球数: [16, 8, 4, 3, 5, 10, 20, 30],
      比分: [],
      半全场: [],
    },
    marketEligibility: {
      让球胜平负: {
        qualification: "qualified",
        salesStatus: "selling",
        handicap: -1,
        cutoffAt: kickoffAt,
      },
    },
  };
  const companies = [2, 3].map((companyId) => ({
    companyId,
    fetchedAt,
    win: 2,
    draw: 3.2,
    lose: 3.8,
    handicap: -0.25,
    homePrice: 0.9,
    awayPrice: 0.95,
    total: 2.5,
    overPrice: 0.9,
    underPrice: 0.95,
    missingFields: [],
    invalidFields: [],
    upstreamUpdatedAt: null,
  }));
  return {
    schemaVersion: 1,
    kind: "prediction-unit-computation",
    officialData: {
      manifestState: "complete",
      fetchedAt,
      source: "test-only",
      sourcePage: "https://example.invalid/fixture",
      poolStatus: Object.fromEntries(
        ["HAD", "HHAD", "CRS", "TTG", "HAFU"].map((pool) => [
          pool,
          { status: "success", observedAt: fetchedAt },
        ]),
      ),
      matches: [match, { ...match, officialMatchId: "fixture-unselected" }],
    },
    selectedOfficialMatchIds: [match.officialMatchId],
    pendingVerification: [],
    sourceFailures: [],
    unit: {
      schemaVersion: 1,
      namespace: "official",
      calibrationId: "cal-none",
      modelInput: {
        schemaVersion: 1,
        pipelineVersion: PREDICTION_PIPELINE_VERSION,
        decisionAt,
        companies,
        official: {
          officialMatchId: match.officialMatchId,
          salesDate,
          kickoffAt,
          fetchedAt,
          hadOdds: match.odds,
          handicap: -1,
          hhadOdds: match.marketOdds["让球胜平负"],
          totalOdds: match.marketOdds["总进球数"],
          scoreOdds: [],
          halfFullOdds: [],
        },
        teamHistory: { rows: [] },
        matchContext: { status: "unavailable", missing: ["test-only"] },
      },
      modelParameters: { temperature: 1 },
      teamOptions: { league: "test", homeTeamId: "home", awayTeamId: "away", decisionAt },
    },
  };
}
function fixture({ objects, path = ":memory:" } = {}) {
  const sql = new DatabaseSync(path);
  for (const statement of predictionJobSchemaSql()) sql.exec(statement);
  const writes = [],
    bytes = new Map(),
    queries = [];
  const backing = objects || {
    async get(key) {
      return bytes.has(key) ? { text: async () => bytes.get(key) } : null;
    },
    async put(key, value) {
      writes.push(key);
      if (!bytes.has(key)) bytes.set(key, value);
    },
  };
  const adapter = sqliteD1(sql);
  const database = {
    ...adapter,
    prepare(query) {
      queries.push(query);
      return adapter.prepare(query);
    },
  };
  const store = createPredictionJobStore({ database, objects: backing });
  return { sql, store, objects: backing, writes, queries, bytes };
}

test("submission freezes the complete official universe without calling either fit; status is pure", async () => {
  const f = fixture(),
    calls = [];
  try {
    const input = prepared(),
      original = structuredClone(input);
    const runtime = createPredictionUnitRuntime({
      store: f.store,
      codeIdentity,
      compute: (unit) => {
        calls.push(unit);
        return computePredictionUnit(unit);
      },
    });
    const queued = await runtime.enqueue(input);
    assert.equal(queued.status, "queued");
    assert.equal(calls.length, 0);
    assert.deepEqual((await f.store.readPrepared(queued.job.id)).payload, original);
    f.queries.length = 0;
    const writes = f.writes.length;
    assert.deepEqual(await runtime.readStatus(queued.job.id), {
      ok: true,
      jobId: queued.job.id,
      status: "queued",
      numericalOnly: true,
    });
    assert.equal(calls.length, 0);
    assert.equal(f.writes.length, writes);
    assert.ok(f.queries.every((sql) => sql.trimStart().startsWith("SELECT")));
    const consumed = await runtime.consumeOne({ id: queued.job.id });
    assert.equal(consumed.status, "ready");
    assert.equal(calls.length, 1);
    const beforeRead = f.writes.length;
    f.queries.length = 0;
    const ready = await runtime.readStatus(queued.job.id);
    assert.equal(ready.numericalOnly, true);
    assert.equal(ready.result.decisionAt, input.unit.modelInput.decisionAt);
    assert.deepEqual(ready.result.output, computePredictionUnit(input.unit));
    assert.equal("reports" in ready, false);
    assert.equal("predictionId" in ready, false);
    assert.ok(f.queries.every((sql) => sql.trimStart().startsWith("SELECT")));
    assert.equal(f.writes.length, beforeRead);
    assert.deepEqual(input, original);
  } finally {
    f.sql.close();
  }
});

test("actual freshness, individual pools and company clocks cannot be replaced by a new global clock", async () => {
  const input = prepared(),
    now = Date.parse(input.unit.modelInput.decisionAt);
  assert.ok(predictionUnitDeadline(input, now) <= Math.floor((now + 299000) / 1000));
  for (const mutate of [
    (p) => (p.officialData.poolStatus.CRS.observedAt = new Date(now - 301000).toISOString()),
    (p) => (p.unit.modelInput.companies[0].fetchedAt = new Date(now - 301000).toISOString()),
    (p) => (p.officialData.matches[0].kickoffAt = new Date(now - 1).toISOString()),
    (p) => (p.officialData.manifestState = "unknown"),
    (p) => p.selectedOfficialMatchIds.push("missing-selected-fixture"),
    (p) => (p.unit.modelInput.official.totalOdds[0] = 99),
    (p) => (p.unit.modelInput.official.handicap = 1),
    (p) => (p.officialData.matches[0].marketEligibility.让球胜平负.qualification = "not_selling"),
    (p) => p.officialData.matches.push(p.officialData.matches[0]),
  ]) {
    const changed = JSON.parse(JSON.stringify(input));
    mutate(changed);
    assert.throws(() => predictionUnitDeadline(changed, now));
  }
  const f = fixture();
  try {
    let current = now,
      calls = 0;
    const runtime = createPredictionUnitRuntime({
      store: f.store,
      codeIdentity,
      clock: () => current,
      compute: () => {
        calls++;
        return {};
      },
    });
    const queued = await runtime.enqueue(input);
    current += 301000;
    const writes = f.writes.length;
    f.queries.length = 0;
    const status = await runtime.readStatus(queued.job.id);
    assert.equal(status.ok, false);
    assert.equal(calls, 0);
    assert.equal(f.writes.length, writes);
    assert.ok(f.queries.every((sql) => sql.trimStart().startsWith("SELECT")));
    const outcome = await runtime.consumeOne({ id: queued.job.id });
    assert.equal(outcome.ok, false);
    assert.equal(calls, 0);
  } finally {
    f.sql.close();
  }
});

test("official Selling casing cannot bypass a cutoff earlier than kickoff", async () => {
  const input = prepared(),
    now = Date.parse(input.unit.modelInput.decisionAt),
    cutoff = now + 2000;
  for (const salesStatus of ["selling", "Selling", "SELLING", " selling "]) {
    const current = structuredClone(input);
    Object.assign(current.officialData.matches[0].marketEligibility.让球胜平负, {
      salesStatus,
      cutoffAt: new Date(cutoff).toISOString(),
    });
    assert.equal(predictionUnitDeadline(current, now), Math.floor(cutoff / 1000));
    assert.throws(
      () => predictionUnitDeadline(current, cutoff),
      (error) => error.code === "PREDICTION_SALES_CLOSED",
    );
  }
  const f = fixture();
  try {
    let current = now,
      calls = 0;
    const runtime = createPredictionUnitRuntime({
      store: f.store,
      codeIdentity,
      clock: () => current,
      compute: () => {
        calls++;
        return {};
      },
    });
    Object.assign(input.officialData.matches[0].marketEligibility.让球胜平负, {
      salesStatus: "Selling",
      cutoffAt: new Date(cutoff).toISOString(),
    });
    const queued = await runtime.enqueue(input);
    current = cutoff;
    const writes = f.writes.length;
    await assert.rejects(
      () => runtime.enqueue(input),
      (error) => error.code === "PREDICTION_SALES_CLOSED",
    );
    assert.equal(f.writes.length, writes);
    assert.equal((await runtime.readStatus(queued.job.id)).code, "PREDICTION_SALES_CLOSED");
    assert.equal((await runtime.consumeOne({ id: queued.job.id })).code, "PREDICTION_SALES_CLOSED");
    assert.equal(calls, 0);
  } finally {
    f.sql.close();
  }
});

test("build mismatch rejects before cold fit; losing readers neither fail nor cancel the shared task", async () => {
  const f = fixture();
  try {
    const submitter = createPredictionUnitRuntime({ store: f.store, codeIdentity });
    const queued = await submitter.enqueue(prepared());
    let calls = 0;
    const reader = createPredictionUnitRuntime({
      store: f.store,
      codeIdentity: { ...codeIdentity, files: { "changed.js": "c".repeat(64) } },
      compute: () => {
        calls++;
        return {};
      },
    });
    const writes = f.writes.length;
    assert.equal((await reader.readStatus(queued.job.id)).code, "PREDICTION_BUILD_CHANGED");
    assert.equal((await f.store.read(queued.job.id)).status, "queued");
    assert.equal(f.writes.length, writes);
    assert.equal((await reader.consumeOne({ id: queued.job.id })).code, "PREDICTION_BUILD_CHANGED");
    assert.equal(calls, 0);
    assert.equal((await f.store.read(queued.job.id)).status, "failed");
  } finally {
    f.sql.close();
  }
});

test("after-R2 publication freshness guard prevents a numerical result becoming ready", async () => {
  const f = fixture();
  try {
    const input = prepared(),
      now = Date.parse(input.unit.modelInput.decisionAt);
    let current = now;
    const runtime = createPredictionUnitRuntime({
      store: f.store,
      codeIdentity,
      clock: () => current,
      compute: () => ({ marketModel: {}, teamStrengthCandidate: {} }),
    });
    const queued = await runtime.enqueue(input);
    const put = f.objects.put;
    f.objects.put = async (key, value) => {
      await put(key, value);
      if (key.includes("/results/")) current = now + 301000;
    };
    const result = await runtime.consumeOne({ id: queued.job.id });
    assert.equal(result.ok, false);
    assert.equal((await f.store.read(queued.job.id)).status, "failed");
    assert.equal((await f.store.readResult(queued.job.id)).ok, false);
  } finally {
    f.sql.close();
  }
});

test("runtime compute failure stores a bounded code, never raw credential-bearing error text", async () => {
  const f = fixture();
  try {
    const runtime = createPredictionUnitRuntime({
      store: f.store,
      codeIdentity,
      compute: () => {
        throw new Error("Authorization=secret-fixture-only");
      },
    });
    const queued = await runtime.enqueue(prepared());
    const result = await runtime.consumeOne({ id: queued.job.id });
    assert.equal(result.code, "PREDICTION_UNIT_FAILED");
    assert.equal(JSON.stringify(result).includes("secret-fixture-only"), false);
    assert.equal((await f.store.read(queued.job.id)).job.failureCode, "PREDICTION_UNIT_FAILED");
    const input = prepared();
    input.runtimeSecrets = { MATCH_CONTEXT_SIGNING_KEY: "fixture-only" };
    await assert.rejects(() => runtime.enqueue(input), /CREDENTIAL_STORAGE_FORBIDDEN/);
  } finally {
    f.sql.close();
  }
});

test("a delayed SQL reply cannot advertise ready after source expiry or rewrite the immutable result", async () => {
  const f = fixture();
  try {
    const input = prepared(),
      now = Date.parse(input.unit.modelInput.decisionAt);
    let current = now;
    const complete = f.store.complete;
    f.store.complete = async (...args) => {
      const result = await complete(...args);
      assert.equal(result.status, "ready");
      current = now + 301000;
      return result;
    };
    const runtime = createPredictionUnitRuntime({
      store: f.store,
      codeIdentity,
      clock: () => current,
    });
    const queued = await runtime.enqueue(input);
    const result = await runtime.consumeOne({ id: queued.job.id });
    assert.equal(result.ok, false);
    assert.equal(result.code, "PREDICTION_SOURCE_EXPIRED");
    assert.equal((await f.store.read(queued.job.id)).status, "ready");
    assert.equal((await runtime.readStatus(queued.job.id)).ok, false);
  } finally {
    f.sql.close();
  }
});

test("ambiguous selectors are rejected before claiming either namespace", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const runtime = createPredictionUnitRuntime({
      store: f.store,
      codeIdentity,
      compute: () => {
        calls++;
        return {};
      },
    });
    const queued = await runtime.enqueue(prepared());
    f.queries.length = 0;
    assert.equal(
      (await runtime.consumeOne({ id: queued.job.id, namespace: "research" })).code,
      "AMBIGUOUS_TASK_SELECTOR",
    );
    assert.equal(calls, 0);
    assert.equal(f.queries.length, 0);
    assert.equal((await f.store.read(queued.job.id)).status, "queued");
  } finally {
    f.sql.close();
  }
});

test("caller mutation cannot change trusted build identity; delayed enqueue replies reject expiry", async () => {
  const f = fixture();
  try {
    const original = structuredClone(codeIdentity),
      mutable = structuredClone(codeIdentity);
    const input = prepared(),
      now = Date.parse(input.unit.modelInput.decisionAt);
    let current = now;
    const runtime = createPredictionUnitRuntime({
      store: f.store,
      codeIdentity: mutable,
      clock: () => current,
    });
    mutable.files["fixture-compute.js"] = "c".repeat(64);
    const queued = await runtime.enqueue(input);
    assert.deepEqual(queued.job.codeIdentity, original);
    const enqueue = f.store.enqueue;
    f.store.enqueue = async (...args) => {
      const result = await enqueue(...args);
      current = now + 301000;
      return result;
    };
    await assert.rejects(
      () => runtime.enqueue(input),
      (error) => error.code === "PREDICTION_SOURCE_EXPIRED",
    );
    assert.equal((await f.store.read(queued.job.id)).status, "queued");
  } finally {
    f.sql.close();
  }
});

test("an independent worker reopens durable input, cold-computes, and a separate reader verifies it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "football-unit-consumer-")),
    path = join(directory, "jobs.sqlite");
  const keys = join(directory, "objects");
  await mkdir(keys);
  const objects = {
    async get(key) {
      try {
        const bytes = await readFile(
          join(keys, createHash("sha256").update(key).digest("hex")),
          "utf8",
        );
        return { text: async () => bytes };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async put(key, bytes) {
      try {
        await writeFile(join(keys, createHash("sha256").update(key).digest("hex")), bytes, {
          flag: "wx",
        });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    },
  };
  let sql;
  try {
    const f = fixture({ objects, path });
    sql = f.sql;
    const input = prepared();
    const queued = await createPredictionUnitRuntime({ store: f.store, codeIdentity }).enqueue(
      input,
    );
    sql.close();
    sql = null;
    const source = `import {parentPort,workerData} from 'node:worker_threads';
      import {DatabaseSync} from 'node:sqlite';import{readFile,writeFile}from'node:fs/promises';import{join}from'node:path';import{createHash}from'node:crypto';
      const {sqliteD1}=await import(workerData.adapter),{createPredictionJobStore}=await import(workerData.store),{createPredictionUnitRuntime}=await import(workerData.runtime);
      const sql=new DatabaseSync(workerData.path),key=k=>join(workerData.keys,createHash('sha256').update(k).digest('hex'));
      const objects={async get(k){try{const b=await readFile(key(k),'utf8');return{text:async()=>b}}catch(e){if(e.code==='ENOENT')return null;throw e}},async put(k,b){try{await writeFile(key(k),b,{flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e}}};
      try{const store=createPredictionJobStore({database:sqliteD1(sql),objects});parentPort.postMessage(await createPredictionUnitRuntime({store,codeIdentity:workerData.codeIdentity}).consumeOne({id:workerData.id}));}finally{sql.close()}`;
    const worker = new Worker(source, {
      eval: true,
      workerData: {
        path,
        keys,
        id: queued.job.id,
        codeIdentity,
        adapter: new URL("./helpers/cloud-sqlite-fixture.mjs", import.meta.url).href,
        store: new URL("../app/prediction-job-store.js", import.meta.url).href,
        runtime: new URL("../app/prediction-unit-runtime.js", import.meta.url).href,
      },
    });
    const consumed = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code) reject(new Error(`worker exit ${code}`));
      });
    });
    assert.equal(consumed.status, "ready");
    sql = new DatabaseSync(path);
    const store = createPredictionJobStore({ database: sqliteD1(sql), objects });
    const ready = await createPredictionUnitRuntime({ store, codeIdentity }).readStatus(
      queued.job.id,
    );
    assert.deepEqual(ready.result.output, computePredictionUnit(input.unit));
    assert.equal(ready.numericalOnly, true);
    assert.equal(
      sql.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'research_%'").get().n,
      0,
    );
  } finally {
    sql?.close();
    const target = resolve(directory),
      parent = resolve(tmpdir()),
      child = relative(parent, target);
    if (
      !child ||
      child.startsWith("..") ||
      child.includes("/") ||
      child.includes("\\") ||
      !child.startsWith("football-unit-consumer-")
    )
      throw new Error("Unsafe temporary cleanup target");
    await rm(target, { recursive: true, force: true });
  }
});
