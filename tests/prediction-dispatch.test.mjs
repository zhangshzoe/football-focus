import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { parsePredictionDispatchQuery } from "../app/prediction-dispatch.js";
import { waitForPredictionBatch } from "../app/prediction-batch-waiter.js";
import { drainPredictionOutbox } from "../scripts/prediction-outbox-client.mjs";
import { withinPredictionWaitBudget } from "../app/prediction-wait-budget.js";

const id = (key) => `prediction-${key.repeat(64)}`;
const ready = (jobId) => ({
  ok: true,
  jobId,
  status: "ready",
  reports: [{ fixture: true }],
  predictionId: "test-only",
  version: { predictionId: "test-only" },
});

test("preparation and enqueue waits share the deadline and lease cancellation, with no late next stage", async () => {
  for (const stage of ["preparation", "enqueue"]) {
    await assert.rejects(
      withinPredictionWaitBudget({ deadlineMs: Date.now() + 15 }, async () => {
        await new Promise(() => {});
        return stage;
      }),
      { code: "PREDICTION_WAIT_TIMEOUT" },
    );
    const controller = new AbortController();
    let finish,
      advanced = 0;
    const promise = withinPredictionWaitBudget(
      { deadlineMs: Date.now() + 1000, signal: controller.signal },
      async ({ guard }) => {
        await new Promise((resolve) => {
          finish = resolve;
        });
        guard();
        advanced++;
      },
    );
    await Promise.resolve();
    controller.abort(Object.assign(new Error("lease lost"), { code: "CLOUD_LEASE_LOST" }));
    await assert.rejects(promise, { code: "CLOUD_LEASE_LOST" });
    finish();
    await Promise.resolve();
    assert.equal(advanced, 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("dispatch accepts only bounded lane/cursor selection, never a clock or model identity", () => {
  assert.deepEqual(parsePredictionDispatchQuery("https://test.invalid?kind=unit"), {
    kind: "unit",
    namespace: "official",
    limit: 25,
    after: null,
  });
  for (const query of [
    "kind=batch&namespace=research",
    "kind=unit&limit=26",
    "kind=unit&limit=0",
    "kind=unit&limit=1&limit=2",
    "kind=unit&codeHash=anything",
    "kind=unit&clock=1",
    "kind=unit&cursor=%7B%7D",
    "kind=other",
  ])
    assert.throws(() => parsePredictionDispatchQuery(`https://test.invalid?${query}`));
});

test("read-only waiter follows one job, fixed deadline and cleans up after many polls", async () => {
  const controller = new AbortController();
  let reads = 0;
  const result = await waitForPredictionBatch({
    jobId: id("a"),
    signal: controller.signal,
    deadlineMs: Date.now() + 1000,
    pollIntervalMs: 1,
    readStatus: async (jobId) =>
      ++reads < 30 ? { ok: true, jobId, status: "queued" } : ready(jobId),
  });
  assert.equal(result.status, "ready");
  assert.equal(reads, 30);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("immediate abort starts no read and an unresponsive read cannot extend the deadline", async () => {
  let reads = 0;
  const controller = new AbortController();
  const options = {
    jobId: id("a"),
    signal: controller.signal,
    deadlineMs: Date.now() + 1000,
    readStatus: () => {
      reads++;
      return new Promise(() => {});
    },
  };
  const promise = waitForPredictionBatch(options);
  controller.abort(Object.assign(new Error("lease lost"), { code: "CLOUD_LEASE_LOST" }));
  await assert.rejects(promise, { code: "CLOUD_LEASE_LOST" });
  assert.equal(reads, 0);
  const later = new AbortController();
  await assert.rejects(
    waitForPredictionBatch({ ...options, signal: later.signal, deadlineMs: Date.now() + 15 }),
    { code: "PREDICTION_WAIT_TIMEOUT" },
  );
  assert.equal(getEventListeners(later.signal, "abort").length, 0);
});

test("ready after expiry, mismatched identity, pending reports and failed terminal are refused", async () => {
  for (const result of [
    { ...ready(id("b")) },
    { ok: true, jobId: id("a"), status: "queued", reports: [] },
    { ok: false, jobId: id("a"), status: "failed", code: "PREDICTION_SOURCE_EXPIRED" },
  ])
    await assert.rejects(
      waitForPredictionBatch({
        jobId: id("a"),
        deadlineMs: Date.now() + 1000,
        readStatus: async () => result,
      }),
    );
  let now = 1;
  await assert.rejects(
    waitForPredictionBatch({
      jobId: id("a"),
      deadlineMs: 100,
      clock: () => now,
      readStatus: async () => {
        now = 100;
        return ready(id("a"));
      },
    }),
    { code: "PREDICTION_WAIT_TIMEOUT" },
  );
});

test("external driver uses distinct HTTP consumers and advances past pending parents", async () => {
  const calls = [],
    first = { id: id("a"), createdAtEpoch: 1 },
    second = { id: id("b"), createdAtEpoch: 2 };
  const result = await drainPredictionOutbox({
    origin: "https://test.invalid",
    token: "test-only-token".repeat(4),
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      assert.equal(options.redirect, "error");
      if (url.pathname === "/api/prediction-dispatch") {
        const kind = url.searchParams.get("kind"),
          after = url.searchParams.get("cursor");
        return Response.json({
          kind,
          namespace: "official",
          jobs: kind === "unit" ? [first] : after ? [second] : [first],
          nextCursor: kind === "batch" && !after ? first : null,
        });
      }
      const { id: jobId } = JSON.parse(options.body);
      return Response.json({
        ok: true,
        jobId,
        status: url.pathname.endsWith("units") || jobId === second.id ? "ready" : "queued",
      });
    },
  });
  assert.equal(result.lanes.unit.ready, 1);
  assert.equal(result.lanes.batch.ready, 1);
  assert.equal(result.lanes.batch.pending, 1);
  assert.equal(calls.filter((row) => row.method === "POST").length, 3);
});

test("driver timeout bounds stalled HTTP; authorization failures do not fall back or leak a key", async () => {
  const options = { origin: "https://test.invalid", token: "test-only-token".repeat(4) };
  await assert.rejects(
    drainPredictionOutbox({
      ...options,
      deadlineMs: Date.now() + 500,
      fetchImpl: () => new Promise(() => {}),
    }),
    { code: "OUTBOX_DEADLINE" },
  );
  await assert.rejects(
    drainPredictionOutbox({
      ...options,
      fetchImpl: async () => new Response("no", { status: 401 }),
    }),
    { code: "OUTBOX_UNAUTHORIZED" },
  );
  await assert.rejects(drainPredictionOutbox({ ...options, origin: "http://not-local.invalid" }), {
    code: "INVALID_OUTBOX_DRIVER",
  });
});
