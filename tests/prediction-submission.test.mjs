import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { sqliteD1 } from "./helpers/cloud-sqlite-fixture.mjs";
import { predictionSubmission, predictionRuntimeSchemaSql } from "../app/prediction-submission.js";
import { predictionJobSchemaSql } from "../app/prediction-job-store.js";
import { readPredictionRequest } from "../app/prediction-request-body.js";

test("public submission body is bounded before buffering and rejects malformed JSON", async () => {
  assert.deepEqual(
    await readPredictionRequest(
      new Request("http://test.invalid", { method: "POST", body: '{"fixtureIds":["123"]}' }),
    ),
    { fixtureIds: ["123"] },
  );
  for (const body of [" ".repeat(20001), "<html>"]) {
    await assert.rejects(
      readPredictionRequest(new Request("http://test.invalid", { method: "POST", body })),
      { code: "INVALID_FIXTURE_SELECTION" },
    );
  }
});

function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(predictionRuntimeSchemaSql);
  predictionJobSchemaSql().forEach((s) => sql.exec(s));
  let now = Date.now(),
    calls = 0,
    status = "queued";
  const runtime = {
    readStatus: async (id) => ({ ok: true, status, jobId: id }),
    enqueue: async () => ({
      ok: true,
      job: { id: `job-${++calls}`, expiresAtEpoch: Math.floor(now / 1000) + 300 },
    }),
  };
  const config = {
    database: sqliteD1(sql),
    runtime,
    prepare: async (ids) => ({ ids }),
    buildIdentity: "build1",
    clock: () => now,
  };
  const service = predictionSubmission(config);
  return {
    sql,
    service,
    config,
    calls: () => calls,
    advance: (ms) => (now += ms),
    setStatus: (value) => (status = value),
    beat: () =>
      service.put(
        "consumer-heartbeat",
        { build: "build1", status: "checked", trigger: "service" },
        now + 90000,
      ),
  };
}

test("admission requires independent consumer, reuses clicks, refresh has bounded cost", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.submit(["1"]), { code: "INDEPENDENT_CONSUMER_UNAVAILABLE" });
    assert.equal(f.calls(), 0);
    await f.beat();
    const first = await f.service.submit(["1"]);
    const repeated = await predictionSubmission(f.config).submit(["1"]);
    assert.equal(first.jobId, repeated.jobId);
    assert.equal(repeated.reused, true);
    await f.service.put(
      "consumer-heartbeat",
      { build: "build1", status: "checked", trigger: "manual" },
      Date.now() + 90000,
    );
    assert.equal((await f.service.submit(["1"])).jobId, first.jobId);
    await assert.rejects(f.service.submit(["2"]), { code: "INDEPENDENT_CONSUMER_UNAVAILABLE" });
    await f.beat();
    await assert.rejects(f.service.submit(["1"], true), { code: "PREDICTION_RATE_LIMITED" });
    f.advance(11000);
    assert.notEqual((await f.service.submit(["1"], true)).jobId, first.jobId);
    assert.equal(f.calls(), 2);
    f.advance(91000);
    await assert.rejects(f.service.submit(["1"]), { code: "INDEPENDENT_CONSUMER_UNAVAILABLE" });
    await assert.rejects(
      predictionSubmission({ ...f.config, buildIdentity: "build2" }).submit(["1"]),
      { code: "INDEPENDENT_CONSUMER_UNAVAILABLE" },
    );
  } finally {
    f.sql.close();
  }
});

test("concurrent preparation, restart and expiry do not admit unbounded work", async () => {
  const f = fixture();
  try {
    await f.beat();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const service = predictionSubmission({
      ...f.config,
      prepare: async () => {
        await gate;
        return {};
      },
    });
    const pending = service.submit(["1"]);
    // Let D1 admission complete, not a timing-dependent network sleep.
    while (!(await f.service.read("submission-admission"))) await Promise.resolve();
    await assert.rejects(f.service.submit(["2"]), { code: "PREDICTION_RATE_LIMITED" });
    f.advance(31000);
    await f.service.submit(["2"]);
    release();
    await assert.rejects(pending, { code: "PREPARATION_LEASE_EXPIRED" });
    assert.equal(f.calls(), 1);
  } finally {
    f.sql.close();
  }
});

test("storage and source failures are not empty successful predictions", async () => {
  const f = fixture();
  try {
    await f.beat();
    await assert.rejects(
      predictionSubmission({
        ...f.config,
        prepare: async () => {
          throw Object.assign(new Error(), { code: "OFFICIAL_SOURCE_UNAVAILABLE" });
        },
      }).submit(["1"]),
      { code: "OFFICIAL_SOURCE_UNAVAILABLE" },
    );
    assert.equal(f.calls(), 0);
    f.advance(11000);
    await assert.rejects(
      predictionSubmission({
        ...f.config,
        runtime: {
          ...f.config.runtime,
          enqueue: async () => ({ ok: false, code: "STORAGE_FAILED" }),
        },
      }).submit(["1"]),
      { code: "STORAGE_FAILED" },
    );
  } finally {
    f.sql.close();
  }
});
