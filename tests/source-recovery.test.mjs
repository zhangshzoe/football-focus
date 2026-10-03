import test from "node:test";
import assert from "node:assert/strict";
import { sourceRecovery } from "../app/source-recovery.js";
import { predictionRuntimeOverview } from "../app/prediction-runtime-overview.js";
import { DatabaseSync } from "node:sqlite";
import { sqliteD1 } from "./helpers/cloud-sqlite-fixture.mjs";
import { predictionRuntimeSchemaSql } from "../app/prediction-submission.js";
import { predictionJobSchemaSql } from "../app/prediction-job-store.js";
import { fetchServerPrediction } from "../app/server-prediction-client.js";

test("blocked sources pause, transient errors back off, recovery never supplies stale data", async () => {
  let now = 0,
    calls = 0;
  const recovery = sourceRecovery({ clock: () => now });
  const blocked = Object.assign(new Error("blocked"), { kind: "access-blocked" });
  const fail = () => {
    calls++;
    throw blocked;
  };
  await assert.rejects(recovery.run("HAD", fail), /blocked/);
  await assert.rejects(recovery.run("HAD", fail), /blocked/);
  assert.equal(calls, 1);
  now = 300001;
  assert.equal(await recovery.run("HAD", () => "fresh"), "fresh");
  await assert.rejects(
    recovery.run("TTG", () => {
      throw new Error("network");
    }),
    /network/,
  );
  await assert.rejects(
    recovery.run("TTG", () => "fake"),
    /network/,
  );
  now += 2001;
  assert.equal(await recovery.run("TTG", () => "fresh2"), "fresh2");
});

test("missing operational evidence stays unknown; manual heartbeat is not a scheduler", async () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(predictionRuntimeSchemaSql);
    predictionJobSchemaSql().forEach((s) => sql.exec(s));
    const params = {
      database: sqliteD1(sql),
      captureStore: { latest: async () => null },
      jobStore: {},
      build: { sourceHash: "build" },
    };
    const missing = await predictionRuntimeOverview(params);
    assert.equal(missing.consumer, null);
    assert.equal(missing.readback.prediction, "unknown");
    assert.equal(missing.sourceCommit, null);
    sql
      .prepare("INSERT INTO prediction_runtime_state VALUES (?,?,?,?)")
      .run(
        "consumer-heartbeat",
        JSON.stringify({ status: "checked", trigger: "manual", build: "build" }),
        Date.now(),
        Date.now() + 90000,
      );
    const manual = await predictionRuntimeOverview(params);
    assert.equal(manual.consumer.fresh, true);
    assert.equal(manual.scheduler.status, "unknown");
    assert.equal(manual.productionValidation, "pending");
  } finally {
    sql.close();
  }
});

test("client distinguishes authorization, absent and invalid responses; no local history fallback", async () => {
  const read = (response) =>
    fetchServerPrediction({ salesDate: "2026-10-03", fetcher: async () => response });
  assert.equal((await read(new Response("", { status: 401 }))).status, "sign-in-required");
  assert.equal((await read(Response.json({ status: "not-found" }))).status, "not-found");
  await assert.rejects(read(new Response("upstream", { status: 503 })));
  await assert.rejects(read(Response.json({ status: "ready", snapshot: { date: "2026-10-03" } })));
});
