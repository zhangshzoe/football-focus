import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { computePredictionUnit } from "../app/prediction-computation.js";
import { DatabaseSync } from "node:sqlite";
import { sqliteD1 } from "./helpers/cloud-sqlite-fixture.mjs";
import { createPredictionJobStore, predictionJobSchemaSql } from "../app/prediction-job-store.js";
import { createPredictionUnitRuntime } from "../app/prediction-unit-runtime.js";
import { createPredictionBatchRuntime } from "../app/prediction-batch-runtime.js";
import { deriveFixture } from "./helpers/prediction-preparation-fixture.mjs";

// Only source I/O is replaced. Numerical fits, identity checks, report projection,
// version hashing and context signing use actual project implementations.
// All synthetic inputs remain in this test process, never real snapshot storage.
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const controlUrl = dataUrl(`let state;export const configure=value=>state=value;
 export class OfficialSportteryError extends Error{}
 export const fetchOfficialSporttery=async()=>state.officialData;
 export const getPublishedCalibration=async()=>null;
 export const MIN_TEMPERATURE_CALIBRATION_MATCHES=30;
 export const readContextBatch=async()=>new Map(state.contexts);
 export const computePredictionUnit=unit=>{state.fits++;return state.compute(unit)};`);
const control = await import(controlUrl);
const modules = new Map();
async function moduleUrl(file) {
  if (modules.has(file.href)) return modules.get(file.href);
  const pending = (async () => {
    if (file.pathname.endsWith(".json"))
      return dataUrl(`export default ${await readFile(file, "utf8")};`);
    let source = await readFile(file, "utf8");
    source = ts.transpileModule(source, {
      fileName: file.pathname,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    for (const [, quote, specifier] of [...source.matchAll(/\bfrom\s+(["'])([^"']+)\1/g)]) {
      let target;
      if (
        /calibration-service|match-context-service|sporttery-official|prediction-computation\.js$/.test(
          specifier,
        )
      )
        target = controlUrl;
      else if (specifier.startsWith(".")) {
        const path = new URL(specifier, file);
        target = /\.js$/.test(path.pathname)
          ? path.href
          : await moduleUrl(
              new URL(path.href + (/\.(?:ts|json)$/.test(path.pathname) ? "" : ".ts")),
            );
      } else target = import.meta.resolve(specifier);
      source = source.replaceAll(`${quote}${specifier}${quote}`, JSON.stringify(target));
    }
    return dataUrl(source);
  })();
  modules.set(file.href, pending);
  return pending;
}
const route = await import(
  await moduleUrl(new URL("../app/api/predictions/route.ts", import.meta.url))
);

async function runFixture(action) {
  const fixture = deriveFixture(),
    originalFetch = globalThis.fetch;
  const sourceCalls = [];
  const state = { ...fixture, compute: computePredictionUnit, fits: 0 };
  control.configure(state);
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://plzx.zgzcw.com/odds/oyzs_ajax.action");
    sourceCalls.push(String(options.body));
    return Response.json(fixture.raw);
  };
  try {
    await action({ fixture, state, sourceCalls });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const codeIdentity = {
  schemaVersion: 1,
  sourceHash: "a".repeat(64),
  files: { "test-only.js": "b".repeat(64) },
};
function durableFixture() {
  const sql = new DatabaseSync(":memory:");
  for (const statement of predictionJobSchemaSql()) sql.exec(statement);
  const queries = [],
    writes = [],
    bytes = new Map(),
    adapter = sqliteD1(sql);
  const database = {
    prepare(query) {
      queries.push(query);
      return adapter.prepare(query);
    },
  };
  const objects = {
    async get(key) {
      return bytes.has(key) ? { text: async () => bytes.get(key) } : null;
    },
    async put(key, value) {
      writes.push(key);
      if (!bytes.has(key)) bytes.set(key, value);
    },
  };
  const store = createPredictionJobStore({ database, objects });
  return { sql, queries, writes, store };
}

test("a complete frozen batch waits without claiming, then independent units and aggregation retain coverage and pure reads", async () => {
  await runFixture(async ({ fixture, state, sourceCalls }) => {
    const f = durableFixture();
    try {
      const batch = JSON.parse(
        JSON.stringify(
          await route.prepareOfficialPredictionBatch([...fixture.ids, "test-unselected"], true),
        ),
      );
      let projections = 0,
        signatures = 0,
        fits = 0;
      const options = {
        store: f.store,
        codeIdentity,
        project: (prepared, outputs) => {
          projections++;
          return route.projectPreparedOfficialReports(prepared, outputs);
        },
        finalize: async (prepared, reports) => {
          signatures++;
          return (await route.completePreparedOfficialPrediction(prepared, reports)).json();
        },
      };
      const submitted = await createPredictionBatchRuntime(options).enqueue(batch);
      assert.equal(submitted.status, "queued");
      assert.equal(state.fits, 0);
      assert.equal(projections + signatures, 0);
      f.queries.length = 0;
      const writes = f.writes.length;
      const waiting = await createPredictionBatchRuntime(options).consumeOne({
        id: submitted.job.id,
      });
      assert.equal(waiting.status, "queued");
      assert.equal("reports" in waiting, false);
      assert.ok(f.queries.every((query) => query.trimStart().startsWith("SELECT")));
      assert.equal(f.writes.length, writes);
      const units = createPredictionUnitRuntime({
        store: f.store,
        codeIdentity,
        compute: (unit) => {
          fits++;
          return computePredictionUnit(unit);
        },
      });
      assert.equal((await units.consumeOne({ id: submitted.job.id })).code, "JOB_KIND_MISMATCH");
      assert.equal((await f.store.read(submitted.job.id)).job.fence, 0);
      assert.equal((await units.consumeOne({ namespace: "official" })).status, "ready");
      assert.equal((await units.consumeOne({ namespace: "official" })).status, "ready");
      assert.equal((await units.consumeOne({ namespace: "official" })).code, "NO_RUNNABLE_JOB");
      assert.equal(fits, 2);
      assert.equal((await f.store.read(submitted.job.id)).status, "queued");
      const completed = await createPredictionBatchRuntime(options).consumeOne({
        id: submitted.job.id,
      });
      assert.equal(completed.status, "ready");
      assert.equal(projections, 1);
      assert.equal(signatures, 1);
      const reader = createPredictionBatchRuntime({
        ...options,
        project: () => {
          throw new Error("reader cannot project");
        },
        finalize: () => {
          throw new Error("reader cannot sign");
        },
      });
      f.queries.length = 0;
      const afterWrite = f.writes.length;
      const ready = await reader.readStatus(submitted.job.id);
      assert.equal(ready.status, "ready");
      assert.equal(ready.coverage.officialMatches, 3);
      assert.equal(ready.coverage.predictedMatches, 2);
      assert.equal(ready.coverage.unavailableMatches, 1);
      assert.equal(ready.unavailableOfficialMatches[0].officialMatchId, "test-unselected");
      assert.deepEqual(
        ready.reports.map((row) => row.officialMatchId),
        ["test-second", "test-first"],
      );
      assert.equal(ready.version.generatedAt, batch.generatedAt);
      assert.equal(ready.officialSource.fetchedAt, batch.officialData.fetchedAt);
      assert.deepEqual(ready.pendingVerification, batch.pendingVerification);
      assert.deepEqual(ready.sourceFailures, batch.sourceFailures);
      assert.ok(f.queries.every((query) => query.trimStart().startsWith("SELECT")));
      assert.equal(f.writes.length, afterWrite);
      assert.equal(sourceCalls.length, 1);
      const persisted = await f.store.readResult(submitted.job.id);
      assert.equal(persisted.result.computationAudit.length, 2);
      assert.ok(
        persisted.result.computationAudit.every(
          (row) => row.computationCompletedAt >= row.computationStartedAt,
        ),
      );
      assert.equal(JSON.stringify(persisted).includes("MATCH_CONTEXT_SIGNING_KEY"), false);
    } finally {
      f.sql.close();
    }
  });
});

test("partial or expired finalization cannot publish a full batch, and an empty unit list is not fake complete coverage", async () => {
  await runFixture(async ({ fixture }) => {
    const batch = JSON.parse(
      JSON.stringify(await route.prepareOfficialPredictionBatch(fixture.ids, true)),
    );
    for (const mode of ["partial", "expired", "proof"]) {
      const f = durableFixture();
      try {
        let current = Date.now();
        const options = {
          store: f.store,
          codeIdentity,
          clock: () => current,
          project: route.projectPreparedOfficialReports,
          finalize: async (prepared, reports) => {
            const envelope = await (
              await route.completePreparedOfficialPrediction(prepared, reports)
            ).json();
            if (mode === "partial") envelope.reports.pop();
            else if (mode === "expired") current += 301000;
            else envelope.reports[0].contextProof = null;
            return envelope;
          },
        };
        const runtime = createPredictionBatchRuntime(options);
        const targetBatch = structuredClone(batch);
        if (mode === "proof")
          targetBatch.units[0].unit.modelInput.matchContext = {
            status: "partial",
            observedAt: batch.generatedAt,
            fixtures: [],
            sources: [],
            missing: ["test-only"],
          };
        const submitted = await runtime.enqueue(targetBatch);
        const units = createPredictionUnitRuntime({ store: f.store, codeIdentity });
        for (const child of submitted.children)
          assert.equal((await units.consumeOne({ id: child.id })).status, "ready");
        const result = await runtime.consumeOne({ id: submitted.job.id });
        assert.equal(result.ok, false);
        assert.equal(
          result.code,
          mode === "partial"
            ? "BATCH_FINAL_ENVELOPE_MISMATCH"
            : mode === "expired"
              ? "PREDICTION_SOURCE_EXPIRED"
              : "BATCH_CONTEXT_PROOF_INVALID",
        );
        assert.equal((await f.store.read(submitted.job.id)).status, "failed");
        assert.equal((await f.store.readResult(submitted.job.id)).ok, false);
        const empty = { ...batch, units: [] };
        await assert.rejects(
          () => runtime.enqueue(empty),
          (error) => error.code === "INVALID_PREPARED_BATCH",
        );
      } finally {
        f.sql.close();
      }
    }
  });
});

test("caller mutation and a same-fixture child with different parameters cannot rewrite a frozen batch", async () => {
  await runFixture(async ({ fixture }) => {
    const f = durableFixture();
    try {
      const batch = JSON.parse(
          JSON.stringify(await route.prepareOfficialPredictionBatch(fixture.ids, true)),
        ),
        original = structuredClone(batch);
      const options = {
        store: f.store,
        codeIdentity,
        project: () => {
          throw new Error("mismatched children must not project");
        },
        finalize: () => {
          throw new Error("mismatched children must not sign");
        },
      };
      const runtime = createPredictionBatchRuntime(options);
      const pending = runtime.enqueue(batch);
      batch.units[0].unit.modelParameters.temperature = 2;
      batch.units.reverse();
      const queued = await pending;
      const parent = await f.store.readPrepared(queued.job.id);
      assert.deepEqual(parent.payload.batch, original);
      const wrong = route.officialComputationPayload(original, original.units[0]);
      wrong.unit = structuredClone(wrong.unit);
      wrong.unit.modelParameters.temperature = 2;
      const units = createPredictionUnitRuntime({ store: f.store, codeIdentity });
      const other = await units.enqueue(wrong);
      await units.consumeOne({ id: other.job.id });
      for (const child of queued.children.slice(1)) await units.consumeOne({ id: child.id });
      const forged = structuredClone(parent.payload);
      forged.children[0] = {
        id: other.job.id,
        inputFingerprint: other.job.inputFingerprint,
        preparedHash: other.job.prepared.contentHash,
      };
      const pointer = await f.store.persistPrepared({
        namespace: "official",
        inputIdentity: parent.job.inputIdentity,
        payload: forged,
      });
      const bad = await f.store.enqueue({
        namespace: "official",
        inputIdentity: parent.job.inputIdentity,
        codeIdentity,
        prepared: pointer,
        expiresAtEpoch: parent.job.expiresAtEpoch,
      });
      const outcome = await runtime.consumeOne({ id: bad.job.id });
      assert.equal(outcome.code, "BATCH_CHILD_IDENTITY_MISMATCH");
      assert.equal((await f.store.read(bad.job.id)).job.fence, 0);
    } finally {
      f.sql.close();
    }
  });
});

test("trusted preparation retains all official scope and exclusions without fitting; serialized projection is identical", async () => {
  await runFixture(async ({ fixture, state, sourceCalls }) => {
    const batch = await route.prepareOfficialPredictionBatch(fixture.ids, true);
    assert.equal(state.fits, 0);
    assert.equal(sourceCalls.length, 1);
    assert.equal(batch.officialData.matches.length, 3);
    assert.deepEqual(batch.selectedOfficialMatchIds, fixture.ids);
    assert.equal(batch.pendingVerification.length, 1);
    assert.equal(batch.sourceBatches[0].rows.length, 3);
    assert.equal(
      batch.sourceBatches[0].fetchedAt,
      batch.units[0].unit.modelInput.companies[0].fetchedAt,
    );
    assert.deepEqual(
      batch.units.map((entry) => entry.unit.modelInput.official.officialMatchId),
      ["test-second", "test-first"],
    );
    const transported = JSON.parse(JSON.stringify(batch));
    const outputs = batch.units.map((entry) => computePredictionUnit(entry.unit));
    const before = JSON.stringify(route.projectPreparedOfficialReports(batch, outputs));
    const after = JSON.stringify(
      route.projectPreparedOfficialReports(transported, JSON.parse(JSON.stringify(outputs))),
    );
    assert.equal(after, before);
    assert.equal(state.fits, 0, "pure projection never starts another fit");
    assert.equal(sourceCalls.length, 1, "projection never re-fetches a source");
    const reports = JSON.parse(after);
    assert.match(reports[0].marketSignal.narrative, /初盘信息不足/);
    assert.equal(reports[0].marketSignal.asianMovement, null);
    assert.equal(reports[0].modelInput.companies[0].firstHomePrice, null);
    assert.equal(reports[0].teamStrengthCandidate.status, "insufficient-data");
    assert.throws(() => route.projectPreparedOfficialReports(batch, outputs.slice(1)), /数量/);
    const payload = route.officialComputationPayload(batch, batch.units[0]);
    assert.equal(payload.officialData, batch.officialData);
    assert.deepEqual(payload.pendingVerification, batch.pendingVerification);
  });
});

test("existing POST uses the extracted stages and ignores caller odds; version keeps the frozen decision time", async () => {
  await runFixture(async ({ fixture, state, sourceCalls }) => {
    const response = await route.POST(
      new Request("https://example.invalid/api/predictions", {
        method: "POST",
        body: JSON.stringify({
          fixtureIds: fixture.ids,
          forceRefresh: true,
          officialData: { matches: [] },
          odds: [99, 99, 99],
        }),
      }),
    );
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(state.fits, 2);
    assert.equal(sourceCalls.length, 1);
    assert.equal(data.coverage.predictedMatches, 2);
    assert.equal(data.coverage.officialMatches, 2);
    assert.deepEqual(
      data.reports.map((row) => row.officialMatchId),
      ["test-second", "test-first"],
    );
    for (const report of data.reports) {
      assert.deepEqual(report.marketSignal.officialOdds, [2, 3.2, 3.8]);
      assert.equal(report.modelInput.decisionAt, data.version.generatedAt);
      assert.equal(report.predictionGeneratedAt, data.version.generatedAt);
      assert.equal(report.modelInput.official.fetchedAt, fixture.officialData.fetchedAt);
      assert.equal(report.modelInput.official.handicap, -1);
      assert.equal(report.calibrationVersion, "cal-none");
    }
    assert.equal(data.fetchedAt, data.version.generatedAt);
  });
});

test("source and exact official handicap failures are rejected before any fit", async () => {
  await runFixture(async ({ fixture, state }) => {
    fixture.officialData.matches[0].marketEligibility.让球胜平负.handicap = null;
    await assert.rejects(
      () => route.prepareOfficialPredictionBatch(fixture.ids, true),
      (error) => error.code === "OFFICIAL_HANDICAP_MISMATCH",
    );
    assert.equal(state.fits, 0);
    const response = await route.POST(
      new Request("https://example.invalid/api/predictions", {
        method: "POST",
        body: JSON.stringify({ fixtureIds: ["not-current"], forceRefresh: true }),
      }),
    );
    assert.equal(response.status, 409);
    assert.deepEqual((await response.json()).unavailableOfficialMatchIds, ["not-current"]);
    assert.equal(state.fits, 0);
  });
});
