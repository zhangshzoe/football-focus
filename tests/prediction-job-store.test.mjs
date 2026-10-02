import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPredictionJobStore,
  predictionJobIdentity,
  predictionJobSchemaSql,
} from "../app/prediction-job-store.js";
import { sqliteD1, researchDatabase } from "./helpers/cloud-sqlite-fixture.mjs";

const inputIdentity = {
  schemaVersion: 1,
  fixtureKey: "fixture-only|100001",
  decisionAt: "2000-01-01T00:00:00.000Z",
  scope: "fixture",
  calibrationId: "none",
  parameters: { home: 1.4, away: 1.1 },
};
const codeIdentity = {
  pipelineVersion: "fixture-pipeline-v1",
  sourceHash: "a".repeat(64),
  dependencyHashes: { teamStrength: "b".repeat(64), distribution: "c".repeat(64) },
};
const payload = {
  fixture: true,
  completePreparedUnit: { prices: [1.9, 3.4, 3.8], sourceObservedAt: "2000-01-01T00:00:00Z" },
};
const resultPayload = {
  fixture: true,
  homeRate: 1.4,
  awayRate: 1.1,
  probabilities: [0.44, 0.28, 0.28],
};

function objectStore() {
  const bytes = new Map(),
    puts = [];
  return {
    bytes,
    puts,
    async put(key, value, options) {
      puts.push({ key, value, options });
      if (!bytes.has(key)) bytes.set(key, value);
      return {};
    },
    async get(key) {
      return bytes.has(key) ? { text: async () => bytes.get(key) } : null;
    },
  };
}
function install(sql) {
  for (const migration of predictionJobSchemaSql()) sql.exec(migration);
}
function fixture({ path = ":memory:", sql, objects = objectStore(), migrate = true } = {}) {
  const connection = sql || new DatabaseSync(path);
  if (migrate) install(connection);
  const database = sqliteD1(connection);
  return {
    sql: connection,
    database,
    objects,
    store: createPredictionJobStore({ database, objects }),
  };
}
async function queued(
  store,
  {
    namespace = "official",
    identity = inputIdentity,
    code = codeIdentity,
    body = payload,
    ttlSeconds = 120,
  } = {},
) {
  const prepared = await store.persistPrepared({
    namespace,
    inputIdentity: identity,
    payload: body,
  });
  assert.equal(prepared.ok, true);
  const job = await store.enqueue({
    namespace,
    inputIdentity: identity,
    codeIdentity: code,
    prepared,
    ttlSeconds,
  });
  assert.equal(job.ok, true);
  return { ...job, prepared };
}
async function diskFixture() {
  const directory = await mkdtemp(join(tmpdir(), "football-prediction-jobs-"));
  const path = join(directory, "jobs.sqlite");
  const base = fixture({ path });
  base.sql.exec("PRAGMA journal_mode = WAL");
  return { ...base, path, directory };
}
async function waitForDatabaseSecond(sql, at) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (sql.prepare("SELECT unixepoch() AS now").get().now >= at) return;
    await delay(100);
  }
  assert.fail("real database clock did not reach lease/expiry boundary");
}

test("the standalone schema is explicit and the real D1 session contract is used", async () => {
  const sql = new DatabaseSync(":memory:"),
    objects = objectStore();
  try {
    const adapter = sqliteD1(sql),
      constraints = [];
    const store = createPredictionJobStore({
      database: {
        ...adapter,
        withSession(constraint) {
          constraints.push(constraint);
          return adapter;
        },
      },
      objects,
    });
    assert.deepEqual(constraints, ["first-primary"]);
    assert.equal(
      sql.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n,
      0,
    );
    const prepared = await store.persistPrepared({ namespace: "official", inputIdentity, payload });
    await assert.rejects(
      store.enqueue({ namespace: "official", inputIdentity, codeIdentity, prepared }),
      /no such table/,
    );
    install(sql);
    assert.equal(
      (await store.enqueue({ namespace: "official", inputIdentity, codeIdentity, prepared }))
        .status,
      "queued",
    );
    assert.equal(
      sql.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'research_%'").get().n,
      0,
    );
  } finally {
    sql.close();
  }
});

test("prepared content must be durable and verified before a pointer can enter D1", async () => {
  const { store, sql, objects } = fixture();
  try {
    const missing = {
      objectKey: `prediction-jobs/official/prepared/${"a".repeat(64)}.json`,
      contentHash: "a".repeat(64),
    };
    assert.equal(
      (
        await store.enqueue({
          namespace: "official",
          inputIdentity,
          codeIdentity,
          prepared: missing,
        })
      ).code,
      "PREPARED_OBJECT_MISSING",
    );
    const prepared = await store.persistPrepared({ namespace: "official", inputIdentity, payload });
    assert.equal(objects.puts.length, 1);
    assert.equal(objects.puts[0].options.onlyIf.get("If-None-Match"), "*");
    assert.deepEqual(
      await store.persistPrepared({ namespace: "official", inputIdentity, payload }),
      prepared,
    );
    assert.equal(objects.puts.length, 1);
    const original = objects.bytes.get(prepared.objectKey);
    objects.bytes.set(prepared.objectKey, JSON.stringify({ changed: true }));
    assert.equal(
      (await store.enqueue({ namespace: "official", inputIdentity, codeIdentity, prepared })).code,
      "PREPARED_OBJECT_HASH_MISMATCH",
    );
    objects.bytes.set(prepared.objectKey, original);
    const badIdentity = await store.enqueue({
      namespace: "official",
      inputIdentity: { ...inputIdentity, fixtureKey: "other" },
      codeIdentity,
      prepared,
    });
    assert.equal(badIdentity.code, "PREPARED_IDENTITY_MISMATCH");
    assert.equal(sql.prepare("SELECT count(*) AS n FROM prediction_jobs").get().n, 0);
    const enqueued = await store.enqueue({
      namespace: "official",
      inputIdentity,
      codeIdentity,
      prepared,
    });
    const row = sql.prepare("SELECT * FROM prediction_jobs WHERE id = ?").get(enqueued.job.id);
    assert.deepEqual((await store.readPrepared(enqueued.job.id)).payload, payload);
    assert.ok(
      !Object.values(row).some(
        (value) => typeof value === "string" && value.includes("completePreparedUnit"),
      ),
    );
    assert.ok(!Object.keys(row).some((key) => key === "payload_json" || key === "result_json"));
    assert.ok(Math.abs(row.created_at - sql.prepare("SELECT unixepoch() AS now").get().now) <= 1);
    assert.ok(
      row.created_at > Date.parse(inputIdentity.decisionAt) / 1000,
      "real creation time is not submitted observation/decision time",
    );
  } finally {
    sql.close();
  }
});

test("failed R2 persistence/readback and credential-bearing data never produce an accepted job", async () => {
  const sql = new DatabaseSync(":memory:");
  install(sql);
  try {
    const absentObjects = {
      async put() {},
      async get() {
        return null;
      },
    };
    const unavailable = createPredictionJobStore({
      database: sqliteD1(sql),
      objects: absentObjects,
    });
    assert.equal(
      (await unavailable.persistPrepared({ namespace: "official", inputIdentity, payload })).code,
      "OBJECT_MISSING",
    );
    const objects = objectStore(),
      store = createPredictionJobStore({ database: sqliteD1(sql), objects });
    for (const sensitive of ["authorization", "access_token", "apiKey", "cookie", "userToken"]) {
      await assert.rejects(
        store.persistPrepared({
          namespace: "official",
          inputIdentity,
          payload: { [sensitive]: "fixture-credential" },
        }),
        { code: "CREDENTIAL_STORAGE_FORBIDDEN" },
      );
      await assert.rejects(
        store.persistPrepared({
          namespace: "official",
          inputIdentity: { [sensitive]: "fixture-credential" },
          payload,
        }),
        { code: "CREDENTIAL_STORAGE_FORBIDDEN" },
      );
    }
    assert.equal(objects.puts.length, 0);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM prediction_jobs").get().n, 0);
    await assert.rejects(
      store.persistPrepared({
        namespace: "official",
        inputIdentity,
        payload: { silentlyLost: undefined },
      }),
      { code: "INVALID_JSON_PAYLOAD" },
    );
  } finally {
    sql.close();
  }
});

test("full input/code identity and namespace isolate jobs; canonical duplicates are idempotent", async () => {
  const { store, sql } = fixture();
  try {
    const original = await queued(store);
    const again = await store.enqueue({
      namespace: "official",
      inputIdentity: {
        parameters: { away: 1.1, home: 1.4 },
        calibrationId: "none",
        scope: "fixture",
        decisionAt: inputIdentity.decisionAt,
        fixtureKey: inputIdentity.fixtureKey,
        schemaVersion: 1,
      },
      codeIdentity: {
        dependencyHashes: { distribution: "c".repeat(64), teamStrength: "b".repeat(64) },
        sourceHash: "a".repeat(64),
        pipelineVersion: "fixture-pipeline-v1",
      },
      prepared: original.prepared,
      ttlSeconds: 600,
    });
    assert.equal(again.enqueued, false);
    assert.equal(again.job.id, original.job.id);
    assert.equal(again.job.expiresAtEpoch, original.job.expiresAtEpoch);
    const changedInput = await queued(store, {
      identity: { ...inputIdentity, parameters: { home: 1.400001, away: 1.1 } },
    });
    const changedCode = await queued(store, {
      code: {
        ...codeIdentity,
        dependencyHashes: { ...codeIdentity.dependencyHashes, teamStrength: "d".repeat(64) },
      },
    });
    const changedVersion = await queued(store, {
      code: { ...codeIdentity, pipelineVersion: "fixture-pipeline-v2" },
    });
    const changedPayload = await queued(store, { body: { ...payload, extraSource: true } });
    const research = await queued(store, { namespace: "research" });
    assert.equal(
      new Set(
        [original, changedInput, changedCode, changedVersion, changedPayload, research].map(
          (value) => value.job.id,
        ),
      ).size,
      6,
    );
    assert.equal(sql.prepare("SELECT count(*) AS n FROM prediction_jobs").get().n, 6);
    const identity = predictionJobIdentity({
      namespace: "official",
      inputIdentity,
      codeIdentity,
      preparedHash: original.prepared.contentHash,
    });
    assert.equal(identity.id, original.job.id);
    assert.equal(identity.inputFingerprint, original.prepared.inputFingerprint);
    assert.deepEqual(JSON.parse(identity.codeIdentityJson), codeIdentity);
    await assert.rejects(store.claimNext({ namespace: "unknown" }), {
      code: "INVALID_JOB_NAMESPACE",
    });
    const namespaceClaim = await store.claimNext({ namespace: "research" });
    assert.equal(namespaceClaim.job.id, research.job.id);
    assert.equal((await store.read(original.job.id)).status, "queued");
  } finally {
    sql.close();
  }
});

test(
  "two real SQLite worker connections compete for exactly one atomic claim",
  { timeout: 20000 },
  async () => {
    const { store, sql, directory, path } = await diskFixture();
    const workers = [];
    try {
      const enqueued = await queued(store);
      const program = `const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { DatabaseSync } = await import('node:sqlite');
        const { sqliteD1 } = await import(workerData.helper);
        const { createPredictionJobStore } = await import(workerData.store);
        const sql = new DatabaseSync(workerData.path);
        const store = createPredictionJobStore({ database: sqliteD1(sql), objects: { async get() { return null; }, async put() {} } });
        parentPort.postMessage('ready');
        parentPort.once('message', async () => {
          try { parentPort.postMessage(await store.claim({ id: workerData.id, leaseSeconds: 20 })); }
          catch (error) { parentPort.postMessage({ error: error.message }); }
          finally { sql.close(); }
        });
      })().catch(error => { throw error; });`;
      const runs = [1, 2].map(() => {
        const worker = new Worker(program, {
          eval: true,
          workerData: {
            path,
            id: enqueued.job.id,
            helper: new URL("./helpers/cloud-sqlite-fixture.mjs", import.meta.url).href,
            store: new URL("../app/prediction-job-store.js", import.meta.url).href,
          },
        });
        workers.push(worker);
        let readyResolve, readyReject;
        const ready = new Promise((resolve, reject) => {
          readyResolve = resolve;
          readyReject = reject;
        });
        const result = new Promise((resolve, reject) => {
          worker.on("error", (error) => {
            readyReject(error);
            reject(error);
          });
          worker.on("message", (message) =>
            message === "ready" ? readyResolve() : resolve(message),
          );
        });
        return { worker, ready, result };
      });
      await Promise.all(runs.map((run) => run.ready));
      for (const run of runs) run.worker.postMessage("go");
      const results = await Promise.all(runs.map((run) => run.result));
      assert.equal(results.filter((result) => result.claimed).length, 1);
      assert.ok(results.every((result) => !result.error));
      assert.equal(results.find((result) => !result.claimed).code, "JOB_BUSY");
      const row = sql
        .prepare("SELECT *, unixepoch() AS now FROM prediction_jobs WHERE id = ?")
        .get(enqueued.job.id);
      assert.equal(row.fence, 1);
      assert.ok(row.lease_until - row.now > 15 && row.lease_until - row.now <= 20);
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      sql.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("claimNext is atomic across two connections and research leases remain completely independent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "football-prediction-isolation-")),
    path = join(directory, "jobs.sqlite");
  const sql = await researchDatabase(path),
    objects = objectStore();
  install(sql);
  const sql2 = new DatabaseSync(path);
  try {
    const first = createPredictionJobStore({ database: sqliteD1(sql), objects });
    const second = createPredictionJobStore({ database: sqliteD1(sql2), objects });
    sql
      .prepare(
        "INSERT INTO research_capture_leases(scope_key, owner_token, fence, lease_until) VALUES (?, ?, ?, unixepoch() + 120)",
      )
      .run("research-writer", "fixture-research-owner", 81);
    const official = await queued(first),
      research = await queued(first, { namespace: "research" });
    const claims = await Promise.all([
      first.claimNext({ namespace: "official" }),
      second.claimNext({ namespace: "official" }),
    ]);
    assert.equal(claims.filter((result) => result.claimed).length, 1);
    assert.equal(claims.find((result) => result.claimed).job.id, official.job.id);
    assert.equal((await second.claimNext({ namespace: "research" })).job.id, research.job.id);
    const evidenceLease = sql.prepare("SELECT * FROM research_capture_leases").get();
    assert.equal(evidenceLease.owner_token, "fixture-research-owner");
    assert.equal(evidenceLease.fence, 81);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM research_capture_records").get().n, 0);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM research_result_events").get().n, 0);
  } finally {
    sql2.close();
    sql.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "a real expired lease is recovered after reopening; old worker cannot renew, fail or complete",
  { timeout: 10000 },
  async () => {
    const { store, sql, objects, directory, path } = await diskFixture();
    let recoveredConnection;
    try {
      const enqueued = await queued(store),
        initial = await store.claim({ id: enqueued.job.id, leaseSeconds: 1 });
      assert.equal(initial.lease.fence, 1);
      const createdAt = initial.job.createdAt,
        firstStartedAt = initial.job.firstStartedAt,
        expiresAt = initial.job.expiresAtEpoch;
      await waitForDatabaseSecond(sql, initial.lease.leaseUntil);
      assert.equal((await store.renew(initial.lease)).code, "LEASE_LOST");
      sql.close();
      recoveredConnection = new DatabaseSync(path);
      const recovered = createPredictionJobStore({
        database: sqliteD1(recoveredConnection),
        objects,
      });
      const next = await recovered.claimNext({ namespace: "official", leaseSeconds: 10 });
      assert.equal(next.claimed, true);
      assert.equal(next.job.id, enqueued.job.id);
      assert.equal(next.lease.fence, 2);
      assert.notEqual(next.lease.token, initial.lease.token);
      assert.equal(next.job.createdAt, createdAt);
      assert.equal(next.job.firstStartedAt, firstStartedAt);
      assert.equal(next.job.expiresAtEpoch, expiresAt);
      assert.equal((await recovered.renew(initial.lease)).code, "LEASE_LOST");
      assert.equal(
        (await recovered.fail(initial.lease, { code: "OLD_WORKER_FAILED" })).code,
        "LEASE_LOST",
      );
      assert.equal((await recovered.complete(initial.lease, { stale: true })).code, "LEASE_LOST");
      assert.equal((await recovered.renew(next.lease)).ok, true);
      assert.equal((await recovered.readPrepared(next.job.id)).payload.fixture, true);
      assert.equal((await recovered.complete(next.lease, resultPayload)).status, "ready");
      assert.deepEqual((await recovered.readResult(next.job.id)).result, resultPayload);
      assert.equal((await recovered.complete(initial.lease, { stale: true })).code, "JOB_READY");
      assert.equal(recoveredConnection.prepare("SELECT fence FROM prediction_jobs").get().fence, 2);
    } finally {
      if (recoveredConnection) recoveredConnection.close();
      else {
        try {
          sql.close();
        } catch {}
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "R2 completion crossing a real lease takeover cannot publish the old result",
  { timeout: 10000 },
  async () => {
    const { store, sql, objects, directory, path } = await diskFixture();
    const sql2 = new DatabaseSync(path);
    try {
      const enqueued = await queued(store),
        initial = await store.claim({ id: enqueued.job.id, leaseSeconds: 1 });
      const successor = createPredictionJobStore({ database: sqliteD1(sql2), objects });
      let next;
      const delayedObjects = {
        ...objects,
        async put(key, value, options) {
          await objects.put(key, value, options);
          if (key.includes("/results/")) {
            await waitForDatabaseSecond(sql2, initial.lease.leaseUntil);
            next = await successor.claim({ id: enqueued.job.id, leaseSeconds: 10 });
          }
          return {};
        },
      };
      const oldWorker = createPredictionJobStore({
        database: sqliteD1(sql),
        objects: delayedObjects,
      });
      const completion = await oldWorker.complete(initial.lease, { worker: "old" });
      assert.equal(next.claimed, true);
      assert.equal(next.lease.fence, initial.lease.fence + 1);
      assert.equal(completion.code, "LEASE_LOST");
      assert.equal((await store.read(enqueued.job.id)).job.result, null);
      assert.equal((await successor.complete(next.lease, resultPayload)).status, "ready");
      assert.deepEqual((await store.readResult(enqueued.job.id)).result, resultPayload);
      assert.equal(
        [...objects.bytes.keys()].filter((key) => key.includes("/results/")).length,
        2,
        "orphan bytes remain separate from the accepted result pointer",
      );
    } finally {
      sql2.close();
      sql.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("ready results cannot be overwritten and result missing/tampered bytes are explicit failures", async () => {
  const { store, sql, objects } = fixture();
  try {
    const enqueued = await queued(store),
      claim = await store.claim({ id: enqueued.job.id });
    const ready = await store.complete(claim.lease, resultPayload);
    assert.equal(ready.ok, true);
    assert.equal(ready.status, "ready");
    assert.equal((await store.complete(claim.lease, { replacement: true })).code, "JOB_READY");
    assert.equal((await store.fail(claim.lease, { code: "LATE_FAILURE" })).code, "JOB_READY");
    assert.equal((await store.claim({ id: enqueued.job.id })).claimed, false);
    const again = await store.enqueue({
      namespace: "official",
      inputIdentity,
      codeIdentity,
      prepared: enqueued.prepared,
    });
    assert.equal(again.enqueued, false);
    assert.deepEqual(again.job.result, ready.job.result);
    assert.equal(
      objects.puts.length,
      2,
      "duplicate ready writes do not write a second result object",
    );
    const original = objects.bytes.get(ready.job.result.objectKey);
    objects.bytes.set(ready.job.result.objectKey, JSON.stringify({ forged: true }));
    assert.equal((await store.readResult(enqueued.job.id)).code, "RESULT_OBJECT_HASH_MISMATCH");
    objects.bytes.delete(ready.job.result.objectKey);
    assert.equal((await store.readResult(enqueued.job.id)).code, "RESULT_OBJECT_MISSING");
    objects.bytes.set(ready.job.result.objectKey, original);
    assert.deepEqual((await store.readResult(enqueued.job.id)).result, resultPayload);
  } finally {
    sql.close();
  }
});

test(
  "fixed expiry does not slide on polling, duplicate enqueue, lease renewal or recovery",
  { timeout: 10000 },
  async () => {
    const { store, sql } = fixture();
    try {
      const enqueued = await queued(store, { ttlSeconds: 2 }),
        claim = await store.claim({ id: enqueued.job.id, leaseSeconds: 1 });
      const fixed = enqueued.job.expiresAtEpoch;
      for (let index = 0; index < 3; index++)
        assert.equal((await store.read(enqueued.job.id)).job.expiresAtEpoch, fixed);
      const duplicate = await store.enqueue({
        namespace: "official",
        inputIdentity,
        codeIdentity,
        prepared: enqueued.prepared,
        ttlSeconds: 600,
      });
      assert.equal(duplicate.job.expiresAtEpoch, fixed);
      const renewed = await store.renew(claim.lease, { leaseSeconds: 120 });
      assert.equal(renewed.job.expiresAtEpoch, fixed);
      assert.equal(renewed.lease.leaseUntil, fixed, "lease is capped at the fixed job deadline");
      await waitForDatabaseSecond(sql, fixed);
      const expired = await store.read(enqueued.job.id);
      assert.equal(expired.ok, false);
      assert.equal(expired.status, "expired");
      assert.equal(expired.code, "JOB_EXPIRED");
      assert.equal(
        sql.prepare("SELECT status FROM prediction_jobs").get().status,
        "running",
        "polling derives expiry without a write",
      );
      assert.equal((await store.renew(renewed.lease)).code, "JOB_EXPIRED");
      assert.equal((await store.complete(renewed.lease, resultPayload)).code, "JOB_EXPIRED");
      assert.equal((await store.fail(renewed.lease, { code: "LATE_FAILURE" })).code, "JOB_EXPIRED");
      assert.equal((await store.claim({ id: enqueued.job.id })).code, "JOB_EXPIRED");
      assert.equal(
        sql.prepare("SELECT status FROM prediction_jobs").get().status,
        "expired",
        "a worker mutation may persist expiry",
      );
      assert.equal((await store.readPrepared(enqueued.job.id)).code, "JOB_EXPIRED");
      assert.equal(
        (
          await store.enqueue({
            namespace: "official",
            inputIdentity,
            codeIdentity,
            prepared: enqueued.prepared,
            ttlSeconds: 600,
          })
        ).code,
        "JOB_EXPIRED",
      );
      assert.equal((await store.claimNext({ namespace: "official" })).code, "NO_RUNNABLE_JOB");
      assert.equal((await store.read(enqueued.job.id)).job.expiresAtEpoch, fixed);
    } finally {
      sql.close();
    }
  },
);

test(
  "a completed job expires by the same fixed clock and never returns its expired result",
  { timeout: 10000 },
  async () => {
    const { store, sql } = fixture();
    try {
      const enqueued = await queued(store, { ttlSeconds: 1 }),
        claim = await store.claim({ id: enqueued.job.id });
      assert.equal((await store.complete(claim.lease, resultPayload)).status, "ready");
      await waitForDatabaseSecond(sql, enqueued.job.expiresAtEpoch);
      const expired = await store.readResult(enqueued.job.id);
      assert.equal(expired.code, "JOB_EXPIRED");
      assert.equal(expired.status, "expired");
      assert.ok(
        expired.job.result,
        "expiry keeps audit pointer, while readResult refuses the expired result",
      );
      assert.equal(Object.hasOwn(expired, "result"), false);
    } finally {
      sql.close();
    }
  },
);

test(
  "all polling readers remain SELECT-only, including an expired task and an R2 read crossing expiry",
  { timeout: 10000 },
  async () => {
    const { store, sql, database, objects } = fixture();
    try {
      const enqueued = await queued(store, { ttlSeconds: 1 });
      const selects = [];
      const readOnlyDatabase = {
        prepare(query) {
          assert.match(query.trim(), /^SELECT\b/i, "a polling reader attempted a database write");
          selects.push(query);
          return database.prepare(query);
        },
      };
      const readOnly = createPredictionJobStore({ database: readOnlyDatabase, objects });
      assert.equal((await readOnly.read(enqueued.job.id)).status, "queued");
      assert.deepEqual((await readOnly.readPrepared(enqueued.job.id)).payload, payload);
      assert.equal((await readOnly.readResult(enqueued.job.id)).code, "JOB_QUEUED");
      const originalGet = objects.get.bind(objects);
      const slowReader = createPredictionJobStore({
        database: readOnlyDatabase,
        objects: {
          ...objects,
          async get(key) {
            await waitForDatabaseSecond(sql, enqueued.job.expiresAtEpoch);
            return originalGet(key);
          },
        },
      });
      assert.equal((await slowReader.readPrepared(enqueued.job.id)).code, "JOB_EXPIRED");
      assert.equal((await readOnly.read(enqueued.job.id)).code, "JOB_EXPIRED");
      assert.equal((await readOnly.readPrepared(enqueued.job.id)).code, "JOB_EXPIRED");
      assert.equal((await readOnly.readResult(enqueued.job.id)).code, "JOB_EXPIRED");
      assert.equal(
        sql.prepare("SELECT status, expires_at FROM prediction_jobs").get().status,
        "queued",
      );
      assert.ok(selects.length >= 8);
    } finally {
      sql.close();
    }
  },
);

test("failure and invalid transitions are explicit and an aborted caller wait does not cancel shared work", async () => {
  const { store, sql } = fixture();
  try {
    const first = await queued(store);
    assert.equal((await store.readResult(first.job.id)).code, "JOB_QUEUED");
    const claim = await store.claim({ id: first.job.id });
    assert.equal(
      (await store.renew({ ...claim.lease, token: "00000000-0000-0000-0000-000000000000" })).code,
      "LEASE_LOST",
    );
    const controller = new AbortController();
    controller.abort();
    assert.equal((await store.read(first.job.id)).status, "running");
    assert.equal(typeof store.cancel, "undefined");
    await assert.rejects(store.fail(claim.lease, { code: "raw error containing user details" }), {
      code: "INVALID_FAILURE_CODE",
    });
    assert.equal(
      (await store.fail(claim.lease, { code: "PREPARED_INPUT_EXPIRED" })).status,
      "failed",
    );
    assert.equal((await store.complete(claim.lease, resultPayload)).code, "JOB_FAILED");
    assert.equal((await store.renew(claim.lease)).code, "JOB_FAILED");
    assert.equal((await store.claim({ id: first.job.id })).code, "JOB_FAILED");
    assert.equal((await store.readResult(first.job.id)).code, "JOB_FAILED");
    assert.equal((await store.read(first.job.id)).job.failureCode, "PREPARED_INPUT_EXPIRED");
    assert.equal((await store.read(`prediction-${"f".repeat(64)}`)).code, "JOB_NOT_FOUND");
    await assert.rejects(store.read("'; DROP TABLE prediction_jobs; --"), {
      code: "INVALID_JOB_ID",
    });
    await assert.rejects(store.claim({ id: first.job.id, leaseSeconds: 0 }), {
      code: "INVALID_LEASE_SECONDS",
    });
    const second = await queued(store, {
      identity: { ...inputIdentity, fixtureKey: "'; DROP TABLE prediction_jobs; --" },
    });
    assert.equal(
      (await store.read(second.job.id)).job.inputIdentity.fixtureKey,
      "'; DROP TABLE prediction_jobs; --",
    );
    assert.equal(sql.prepare("SELECT count(*) AS n FROM prediction_jobs").get().n, 2);
  } finally {
    sql.close();
  }
});
