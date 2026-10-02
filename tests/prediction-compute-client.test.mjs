import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  requestPredictionResult,
  readCompletedPredictionResponse,
} from "../app/prediction-compute-client.js";

// Synthetic transport envelopes only; no jobs or predictions are saved.
const ready = {
  reports: [{ id: "fixture", predictionId: "original", sourceFetchedAt: "2026-10-02T01:00:00Z" }],
  predictionId: "original",
  fetchedAt: "2026-10-02T01:00:01Z",
};
const queued = () => Response.json({ jobId: "job-test", status: "queued" }, { status: 202 });
const options = { pollIntervalMs: 1, timeoutMs: 1000 };

test("existing ready official and research envelopes are unchanged and source times are never regenerated", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return Response.json(ready);
  };
  assert.deepEqual(
    await requestPredictionResult({ fixtureIds: ["fixture"], forceRefresh: true, fetcher }),
    ready,
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), { fixtureIds: ["fixture"], forceRefresh: true });
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(await requestPredictionResult({ research: true, fetcher }), ready);
  assert.equal(calls[1].init.method, "GET");
  assert.equal(calls[1].init.body, undefined);
  assert.ok(calls.every((call) => call.init.cache === "no-store"));
});

test("202 queued and running are explicit pending states, never successful empty coverage", async () => {
  const progress = [],
    calls = [];
  const responses = [
    queued(),
    Response.json({ jobId: "job-test", status: "running" }, { status: 202 }),
    Response.json({ ...ready, jobId: "job-test" }),
  ];
  const actual = await requestPredictionResult({
    ...options,
    fixtureIds: ["fixture"],
    onPending: (row) => progress.push(row),
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    },
  });
  assert.deepEqual(actual, { ...ready, jobId: "job-test" });
  assert.deepEqual(
    progress.map((row) => row.status),
    ["queued", "running"],
  );
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      "/api/predictions",
      "/api/prediction-jobs?jobId=job-test",
      "/api/prediction-jobs?jobId=job-test",
    ],
  );
  assert.ok(calls.slice(1).every((call) => call.init.method === "GET"));
});

test("polling stays on the selected server, preserves headers and ignores untrusted status URLs", async () => {
  const calls = [];
  let first = true;
  const actual = await requestPredictionResult({
    ...options,
    endpoint: "https://example.test/api/predictions",
    requestHeaders: { Authorization: "Bearer synthetic-test-token" },
    fetcher: async (url, init) => {
      calls.push([url, init.headers.get("Authorization")]);
      if (first) {
        first = false;
        return Response.json(
          { jobId: "job:test", status: "queued", statusUrl: "https://attacker.test/steal" },
          { status: 202 },
        );
      }
      return Response.json({ ...ready, jobId: "job:test" });
    },
  });
  assert.equal(actual.predictionId, ready.predictionId);
  assert.deepEqual(
    calls.map((row) => row[0]),
    [
      "https://example.test/api/predictions",
      "https://example.test/api/prediction-jobs?jobId=job%3Atest",
    ],
  );
  assert.ok(calls.every((row) => row[1] === "Bearer synthetic-test-token"));
  for (const endpoint of ["//other.test/api/predictions", "api/predictions", "../api/predictions"])
    await assert.rejects(
      requestPredictionResult({
        endpoint,
        fetcher: async () => {
          throw Error("must not fetch");
        },
      }),
      /地址无效/,
    );
});

test("missing, mixed, changed job identity or nonready final state is rejected", async () => {
  for (const value of [
    { status: "queued" },
    { jobId: 123, status: "queued" },
    { jobId: "job-test", status: "queued", reports: [] },
    { jobId: "job-test", status: "queued", predictionId: "fake" },
    { jobId: "../other", status: "running" },
  ])
    await assert.rejects(
      requestPredictionResult({
        ...options,
        fetcher: async () => Response.json(value, { status: 202 }),
      }),
      (error) => error.code === "PREDICTION_RESPONSE_INVALID",
    );
  for (const final of [
    { ...ready, jobId: "another-job" },
    ready,
    { jobId: "job-test", status: "expired", error: "expired", code: "INPUT_EXPIRED" },
    { ...ready, jobId: "job-test", status: "preparing" },
    { ...ready, jobId: "job-test", error: "failed", code: "INPUT_EXPIRED" },
  ]) {
    const responses = [queued(), Response.json(final)];
    await assert.rejects(
      requestPredictionResult({ ...options, fetcher: async () => responses.shift() }),
      (error) =>
        ["PREDICTION_RESPONSE_INVALID", "PREDICTION_NOT_READY", "INPUT_EXPIRED"].includes(
          error.code,
        ),
    );
  }
});

test("the same deadline bounds a stalled initial read, response body and job status read", async () => {
  for (const stage of ["initial", "body", "status"]) {
    let first = true;
    await assert.rejects(
      requestPredictionResult({
        timeoutMs: 30,
        pollIntervalMs: 1,
        fetcher: async () => {
          if (stage === "initial" || (stage === "status" && !first)) return new Promise(() => {});
          first = false;
          if (stage === "status") return queued();
          const response = Response.json(ready);
          response.json = () => new Promise(() => {});
          return response;
        },
      }),
      (error) => error.code === "PREDICTION_WAIT_TIMEOUT",
    );
  }
});

test("source rejection retains exact error code and unknown coverage rather than creating an empty result", async () => {
  const sourceState = { manifestState: "unknown" },
    errorBody = { error: "source unavailable", code: "OFFICIAL_MANIFEST_UNAVAILABLE", sourceState };
  for (const responses of [
    [Response.json(errorBody, { status: 502 })],
    [queued(), Response.json(errorBody, { status: 502 })],
  ])
    await assert.rejects(
      requestPredictionResult({ ...options, fetcher: async () => responses.shift() }),
      (error) =>
        error.code === errorBody.code &&
        error.status === 502 &&
        error.sourceState.manifestState === "unknown",
    );
  await assert.rejects(
    requestPredictionResult({ fetcher: async () => new Response("invalid json", { status: 200 }) }),
    /非 JSON/,
  );
});

test("one overall deadline cannot slide forward during repeated pending polls", async () => {
  let polls = 0;
  const started = Date.now();
  await assert.rejects(
    requestPredictionResult({
      timeoutMs: 30,
      pollIntervalMs: 2,
      fetcher: async () => {
        polls++;
        return queued();
      },
    }),
    (error) => error.code === "PREDICTION_WAIT_TIMEOUT",
  );
  assert.ok(polls >= 2);
  assert.ok(Date.now() - started < 1000);
  await assert.rejects(requestPredictionResult({ timeoutMs: 0 }), /预算无效/);
});

test("abort supersedes a queued generation and cancels its pending network read", async () => {
  const controller = new AbortController();
  let announce;
  const polling = new Promise((resolve) => {
    announce = resolve;
  });
  let first = true;
  const request = requestPredictionResult({
    ...options,
    signal: controller.signal,
    fetcher: async (_url, init) => {
      if (first) {
        first = false;
        return queued();
      }
      announce();
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }),
      );
    },
  });
  await polling;
  controller.abort();
  await assert.rejects(request, (error) => error.name === "AbortError");
  await assert.rejects(
    requestPredictionResult({
      signal: controller.signal,
      fetcher: async () => {
        throw Error("must not fetch");
      },
    }),
    (error) => error.name === "AbortError",
  );
});

test("in-process capture cannot certify pending, missing reports or source failure as completion", async () => {
  assert.deepEqual(await readCompletedPredictionResponse(Response.json(ready)), ready);
  await assert.rejects(
    readCompletedPredictionResponse(queued()),
    (error) => error.code === "PREDICTION_NOT_READY",
  );
  await assert.rejects(
    readCompletedPredictionResponse(Response.json({ status: "complete" })),
    (error) => error.code === "PREDICTION_NOT_READY",
  );
  await assert.rejects(
    readCompletedPredictionResponse(
      Response.json({ error: "blocked", code: "OFFICIAL_ACCESS_BLOCKED" }, { status: 502 }),
    ),
    (error) => error.code === "OFFICIAL_ACCESS_BLOCKED",
  );
  const runtime = await readFile(
    new URL("../app/cloud-research-runtime.ts", import.meta.url),
    "utf8",
  );
  assert.match(runtime, /return readCompletedPredictionResponse\(response\)/);
});
