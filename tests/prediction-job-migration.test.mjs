import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { createPredictionJobStore, predictionJobSchemaSql } from "../app/prediction-job-store.js";
import { computePredictionUnit } from "../app/prediction-computation.js";
import { PREDICTION_PIPELINE_VERSION } from "../app/prediction-model.js";
import { sqliteD1, researchDatabase } from "./helpers/cloud-sqlite-fixture.mjs";

const migration = await readFile(
  new URL("../drizzle/0004_gray_omega_sentinel.sql", import.meta.url),
  "utf8",
);

// Physical test-only R2 emulator lets another worker reopen complete objects.
// It is not a claim that the production R2 binding or cloud schedule is enabled.
function fileObjects(root, fs = { readFile, writeFile, mkdir }, path = { join, dirname }) {
  const filename = (key) => {
    if (!/^prediction-jobs\/(official|research)\/(prepared|results)\/[a-f0-9]{64}\.json$/.test(key))
      throw new Error("Invalid isolated object key");
    return path.join(root, ...key.split("/"));
  };
  return {
    async get(key) {
      try {
        const bytes = await fs.readFile(filename(key), "utf8");
        return { text: async () => bytes };
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    },
    async put(key, bytes, options) {
      if (options.onlyIf.get("If-None-Match") !== "*")
        throw new Error("Create-only write required");
      const file = filename(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      try {
        await fs.writeFile(file, bytes, { flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    },
  };
}

test("generated migration matches the operational store without altering research tables", () => {
  const actual = new DatabaseSync(":memory:"),
    reference = new DatabaseSync(":memory:");
  try {
    assert.doesNotMatch(migration, /\b(?:DROP|ALTER|UPDATE|DELETE|INSERT)\b/i);
    actual.exec(migration);
    predictionJobSchemaSql().forEach((sql) => reference.exec(sql));
    const columns = (db) =>
      db
        .prepare("PRAGMA table_info(prediction_jobs)")
        .all()
        .map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value }));
    assert.deepEqual(columns(actual), columns(reference));
    const indexes = actual.prepare("PRAGMA index_list(prediction_jobs)").all();
    assert.ok(indexes.some((row) => row.name === "idx_prediction_jobs_claim"));
    assert.ok(indexes.some((row) => row.name === "idx_prediction_jobs_expiry"));
    assert.ok(indexes.some((row) => row.unique === 1));
  } finally {
    actual.close();
    reference.close();
  }
});

test("independent worker reopens durable prepared input, executes both fits and persists verified output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "football-focus-prediction-job-"));
  const databasePath = join(directory, "jobs.sqlite"),
    objectRoot = join(directory, "objects");
  let sql, worker;
  try {
    sql = await researchDatabase(databasePath);
    sql.exec(migration);
    const store = createPredictionJobStore({
      database: sqliteD1(sql),
      objects: fileObjects(objectRoot),
    });
    const at = new Date().toISOString();
    const unit = {
      schemaVersion: 1,
      namespace: "official",
      calibrationId: "cal-none",
      modelInput: {
        schemaVersion: 1,
        pipelineVersion: PREDICTION_PIPELINE_VERSION,
        decisionAt: at,
        companies: [2, 3].map((companyId) => ({
          companyId,
          fetchedAt: at,
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
        })),
        official: {
          officialMatchId: "synthetic-test-123",
          salesDate: at.slice(0, 10),
          kickoffAt: new Date(Date.now() + 3600000).toISOString(),
          fetchedAt: at,
          hadOdds: [2, 3.2, 3.8],
          handicap: -1,
          hhadOdds: [4, 3.6, 1.8],
          totalOdds: [16, 8, 4, 3, 5, 10, 20, 30],
        },
        teamHistory: { rows: [] },
      },
      modelParameters: { temperature: 1 },
      teamOptions: {
        league: "test",
        homeTeamId: "uniform-home",
        awayTeamId: "uniform-away",
        decisionAt: at,
      },
    };
    const inputIdentity = { fixtureId: "synthetic-test-123", decisionAt: at };
    const codeIdentity = { isolatedTestImplementation: "real-current-computation" };
    const prepared = await store.persistPrepared({
      namespace: "official",
      inputIdentity,
      payload: unit,
    });
    const queued = await store.enqueue({
      namespace: "official",
      inputIdentity,
      codeIdentity,
      prepared,
      ttlSeconds: 120,
    });
    assert.equal(queued.status, "queued");
    sql.close();
    sql = null;
    const workerCode = `
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      const fs=require('node:fs/promises'),path=require('node:path');
      const fileObjects=${fileObjects.toString()};
      (async()=>{
        const {createPredictionJobStore}=await import(workerData.storeUrl);
        const {computePredictionUnit}=await import(workerData.computeUrl);
        const {sqliteD1}=await import(workerData.fixtureUrl);
        const sql=new DatabaseSync(workerData.databasePath);
        try{
          const store=createPredictionJobStore({database:sqliteD1(sql),objects:fileObjects(workerData.objectRoot,fs,path)});
          const claim=await store.claim({id:workerData.jobId});
          if(!claim.claimed)throw new Error(claim.code);
          const prepared=await store.readPrepared(workerData.jobId);
          if(!prepared.ok)throw new Error(prepared.code);
          const numerical=computePredictionUnit(prepared.payload);
          const completed=await store.complete(claim.lease,numerical);
          if(!completed.ok||completed.status!=='ready')throw new Error(completed.code);
          parentPort.postMessage({ready:true,fence:completed.job.fence});
        }finally{sql.close();}
      })().catch(error=>{console.error(error.message);process.exitCode=1;});
    `;
    worker = new Worker(workerCode, {
      eval: true,
      workerData: {
        databasePath,
        objectRoot,
        jobId: queued.job.id,
        storeUrl: new URL("../app/prediction-job-store.js", import.meta.url).href,
        computeUrl: new URL("../app/prediction-computation.js", import.meta.url).href,
        fixtureUrl: new URL("./helpers/cloud-sqlite-fixture.mjs", import.meta.url).href,
      },
    });
    const result = await new Promise((resolve, reject) => {
      let message;
      worker.once("message", (value) => (message = value));
      worker.once("error", reject);
      worker.once("exit", (code) =>
        code === 0 && message ? resolve(message) : reject(new Error(`Worker ended ${code}`)),
      );
    });
    assert.deepEqual(result, { ready: true, fence: 1 });
    sql = new DatabaseSync(databasePath);
    const reopened = createPredictionJobStore({
      database: sqliteD1(sql),
      objects: fileObjects(objectRoot),
    });
    const completed = await reopened.readResult(queued.job.id);
    assert.equal(completed.status, "ready");
    assert.deepEqual(completed.result, computePredictionUnit(unit));
    assert.equal(completed.result.teamStrengthCandidate.status, "insufficient-data");
    assert.equal(sql.prepare("SELECT count(*) AS n FROM research_capture_records").get().n, 0);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM research_capture_leases").get().n, 0);
  } finally {
    if (worker) await worker.terminate();
    if (sql) sql.close();
    if (
      dirname(directory) !== tmpdir() ||
      !directory.startsWith(join(tmpdir(), "football-focus-prediction-job-"))
    )
      throw new Error("Refusing unexpected temporary cleanup target");
    await rm(directory, { recursive: true, force: true });
  }
});
