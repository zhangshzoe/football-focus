import { createHash } from "node:crypto";
import { predictionJobIdentity } from "./prediction-job-store.js";
import { createPredictionUnitRuntime, predictionUnitDeadline } from "./prediction-unit-runtime.js";

const KIND = "official-prediction-batch";
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const fingerprint = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const failure = (error, jobId) => ({
  ok: false,
  jobId,
  status: "failed",
  code: /^[A-Z][A-Z0-9_]{1,79}$/.test(error?.code || "") ? error.code : "PREDICTION_BATCH_FAILED",
});

export function officialBatchUnitPayload(batch, entry) {
  return {
    schemaVersion: 1,
    kind: "prediction-unit-computation",
    unit: entry.unit,
    officialData: batch.officialData,
    selectedOfficialMatchIds: batch.selectedOfficialMatchIds,
    pendingVerification: batch.pendingVerification,
    sourceFailures: batch.sourceFailures,
  };
}

export function predictionBatchDeadline(batch, now = Date.now()) {
  if (
    batch?.schemaVersion !== 1 ||
    batch.kind !== "official-prediction-batch-prepared" ||
    !Array.isArray(batch.units) ||
    !batch.units.length ||
    batch.units.length > 120 ||
    batch.decisionAt !== batch.generatedAt ||
    !Array.isArray(batch.sportteryMatches)
  )
    fail("INVALID_PREPARED_BATCH");
  const ids = new Set(),
    ordinals = new Set();
  let previous = -1;
  const deadlines = batch.units.map((entry) => {
    const id = entry?.unit?.modelInput?.official?.officialMatchId;
    if (
      typeof id !== "string" ||
      !id ||
      ids.has(id) ||
      !Number.isInteger(entry.ordinal) ||
      entry.ordinal <= previous ||
      ordinals.has(entry.ordinal) ||
      entry.unit.modelInput.decisionAt !== batch.decisionAt
    )
      fail("INVALID_PREPARED_BATCH");
    ids.add(id);
    ordinals.add(entry.ordinal);
    previous = entry.ordinal;
    return predictionUnitDeadline(officialBatchUnitPayload(batch, entry), now);
  });
  const selected = batch.selectedOfficialMatchIds;
  if (
    batch.sportteryMatches.length !== selected.length ||
    new Set(batch.sportteryMatches.map((row) => String(row.officialMatchId || row.matchId || "")))
      .size !== selected.length ||
    batch.sportteryMatches.some(
      (row) => !selected.includes(String(row.officialMatchId || row.matchId || "")),
    )
  )
    fail("INVALID_PREPARED_BATCH");
  return Math.min(...deadlines);
}

// Independent aggregation has no fit callback. It may sign only after every
// frozen child is durably ready. Readers never call project/finalize or claim.
export function createPredictionBatchRuntime({
  store,
  codeIdentity,
  clock = Date.now,
  project,
  finalize,
}) {
  const unitRuntime = createPredictionUnitRuntime({ store, codeIdentity, clock });
  if (typeof project !== "function" || typeof finalize !== "function")
    fail("INVALID_BATCH_CALLBACKS");
  const frozenCode = JSON.parse(JSON.stringify(codeIdentity));
  const codeHash = (identity) =>
    predictionJobIdentity({
      namespace: "official",
      inputIdentity: { kind: KIND },
      codeIdentity: identity,
      preparedHash: "0".repeat(64),
    }).codeHash;
  const expectedCodeHash = codeHash(frozenCode);
  const sameBuild = (job) => {
    if (
      job.namespace !== "official" ||
      job.inputIdentity.kind !== KIND ||
      job.codeHash !== expectedCodeHash ||
      codeHash(job.codeIdentity) !== expectedCodeHash
    )
      fail("PREDICTION_BUILD_CHANGED");
  };
  function validatePrepared(payload) {
    if (
      payload?.schemaVersion !== 1 ||
      payload.kind !== KIND ||
      !Array.isArray(payload.children) ||
      payload.children.length !== payload.batch?.units?.length ||
      new Set(payload.children.map((child) => child.id)).size !== payload.children.length
    )
      fail("BATCH_CHILD_IDENTITY_MISMATCH");
    predictionBatchDeadline(payload.batch, clock());
  }
  async function readPrepared(id) {
    const current = await store.readPrepared(id);
    if (!current.ok) return current;
    sameBuild(current.job);
    validatePrepared(current.payload);
    return current;
  }
  function validateEnvelope(batch, envelope) {
    if (
      !envelope ||
      !Array.isArray(envelope.reports) ||
      envelope.reports.length !== batch.units.length ||
      !envelope.predictionId ||
      envelope.predictionId !== envelope.version?.predictionId ||
      envelope.version?.generatedAt !== batch.generatedAt ||
      envelope.fetchedAt !== batch.generatedAt ||
      envelope.officialSource?.method !== "server-refetch" ||
      envelope.officialSource?.manifestState !== "complete" ||
      envelope.officialSource?.fetchedAt !== batch.officialData.fetchedAt ||
      fingerprint(envelope.officialSource.poolStatus) !==
        fingerprint(batch.officialData.poolStatus) ||
      fingerprint(envelope.officialMatches) !== fingerprint(batch.sportteryMatches) ||
      fingerprint(envelope.pendingVerification) !== fingerprint(batch.pendingVerification) ||
      fingerprint(envelope.sourceFailures) !== fingerprint(batch.sourceFailures) ||
      envelope.coverage?.officialMatches !== batch.sportteryMatches.length ||
      envelope.coverage?.predictedMatches !== batch.units.length ||
      envelope.coverage?.pendingExternalMappings !== batch.pendingVerification.length ||
      !Array.isArray(envelope.unavailableOfficialMatches) ||
      envelope.coverage?.unavailableMatches !== envelope.unavailableOfficialMatches.length ||
      batch.units.length + envelope.unavailableOfficialMatches.length !==
        batch.sportteryMatches.length ||
      envelope.reports.some(
        (report, i) =>
          report.predictionId !== envelope.predictionId ||
          report.officialMatchId !== batch.units[i].unit.modelInput.official.officialMatchId ||
          report.predictionGeneratedAt !== batch.generatedAt ||
          fingerprint(report.modelInput) !== fingerprint(batch.units[i].unit.modelInput) ||
          fingerprint(report.modelParameters) !== fingerprint(batch.units[i].unit.modelParameters),
      )
    )
      fail("BATCH_FINAL_ENVELOPE_MISMATCH");
    const covered = new Set(
      batch.units.map((entry) => entry.unit.modelInput.official.officialMatchId),
    );
    const missing = batch.selectedOfficialMatchIds.filter((id) => !covered.has(id));
    if (
      new Set(envelope.unavailableOfficialMatches.map((row) => row.officialMatchId)).size !==
        missing.length ||
      envelope.unavailableOfficialMatches.some(
        (row) => !missing.includes(row.officialMatchId) || !row.reason,
      )
    )
      fail("BATCH_FINAL_ENVELOPE_MISMATCH");
    for (const report of envelope.reports) {
      const context = report.modelInput.matchContext;
      if (!context || context.status === "unavailable") continue;
      const proof = report.contextProof;
      if (
        !proof ||
        proof.version !== 1 ||
        !/^[a-f0-9]{64}$/.test(proof.signature || "") ||
        proof.contextHash !== fingerprint(context) ||
        ["predictionId", "officialMatchId", "home", "away", "kickoffAt", "inputSnapshotId"].some(
          (key) => proof[key] !== report[key],
        )
      )
        fail("BATCH_CONTEXT_PROOF_INVALID");
    }
  }
  async function readChildren(prepared) {
    const outputs = [],
      audit = [];
    for (let i = 0; i < prepared.children.length; i++) {
      const reference = prepared.children[i],
        entry = prepared.batch.units[i];
      const child = await store.read(reference.id);
      if (!child.ok) return child;
      if (
        child.job.namespace !== "official" ||
        child.job.codeHash !== expectedCodeHash ||
        child.job.inputIdentity.kind !== "prediction-unit-computation" ||
        child.job.inputIdentity.fixtureId !== entry.unit.modelInput.official.officialMatchId ||
        child.job.inputIdentity.decisionAt !== prepared.batch.decisionAt ||
        child.job.inputFingerprint !== reference.inputFingerprint ||
        child.job.prepared.contentHash !== reference.preparedHash
      )
        fail("BATCH_CHILD_IDENTITY_MISMATCH");
      const current = await unitRuntime.readStatus(reference.id, { includePrepared: true });
      if (!current.ok) return current;
      if (current.status !== "ready") return { ok: true, pending: true };
      if (current.result.decisionAt !== prepared.batch.decisionAt)
        fail("BATCH_CHILD_IDENTITY_MISMATCH");
      if (
        fingerprint(current.prepared) !==
        fingerprint(officialBatchUnitPayload(prepared.batch, entry))
      )
        fail("BATCH_CHILD_IDENTITY_MISMATCH");
      outputs.push(current.result.output);
      audit.push({
        jobId: reference.id,
        officialMatchId: child.job.inputIdentity.fixtureId,
        computationStartedAt: current.result.computationStartedAt,
        computationCompletedAt: current.result.computationCompletedAt,
      });
    }
    predictionBatchDeadline(prepared.batch, clock());
    return { ok: true, outputs, audit };
  }
  async function enqueue(batch) {
    // Keep one private source snapshot throughout all child and parent awaits.
    batch = structuredClone(batch);
    const expiresAtEpoch = predictionBatchDeadline(batch, clock()),
      children = [];
    for (const entry of batch.units) {
      const queued = await unitRuntime.enqueue(officialBatchUnitPayload(batch, entry));
      if (!queued.ok) return queued;
      children.push({
        id: queued.job.id,
        inputFingerprint: queued.job.inputFingerprint,
        preparedHash: queued.job.prepared.contentHash,
      });
    }
    const inputIdentity = {
      schemaVersion: 1,
      kind: KIND,
      decisionAt: batch.decisionAt,
      selectedOfficialMatchIds: batch.selectedOfficialMatchIds,
    };
    const saved = await store.persistPrepared({
      namespace: "official",
      inputIdentity,
      payload: { schemaVersion: 1, kind: KIND, batch, children },
    });
    if (!saved.ok) return saved;
    predictionBatchDeadline(batch, clock());
    const queued = await store.enqueue({
      namespace: "official",
      inputIdentity,
      codeIdentity: frozenCode,
      prepared: saved,
      expiresAtEpoch,
    });
    predictionBatchDeadline(batch, clock());
    return queued.ok ? { ...queued, children } : queued;
  }
  async function consumeOne({ id }) {
    let lease;
    try {
      const prepared = await readPrepared(id);
      if (!prepared.ok) return prepared;
      if (prepared.status === "ready")
        return { ok: true, jobId: id, status: "ready", alreadyReady: true };
      if (prepared.status === "failed") return failure({ code: prepared.job.failureCode }, id);
      const children = await readChildren(prepared.payload);
      if (children.pending) return { ok: true, jobId: id, status: prepared.status };
      const claimed = await store.claim({ id, kind: KIND, codeHash: expectedCodeHash });
      if (!claimed.ok || !claimed.claimed) return claimed;
      lease = claimed.lease;
      if (!children.ok) fail(children.code || "BATCH_CHILD_FAILED");
      sameBuild(claimed.job);
      predictionBatchDeadline(prepared.payload.batch, clock());
      const startedAt = new Date(clock()).toISOString();
      const reports = project(prepared.payload.batch, children.outputs);
      if (reports?.then) fail("INVALID_BATCH_PROJECTION");
      const envelope = await finalize(prepared.payload.batch, reports);
      predictionBatchDeadline(prepared.payload.batch, clock());
      validateEnvelope(prepared.payload.batch, envelope);
      const result = {
        schemaVersion: 1,
        kind: "prediction-batch-final-result",
        decisionAt: prepared.payload.batch.decisionAt,
        aggregationStartedAt: startedAt,
        aggregationCompletedAt: new Date(clock()).toISOString(),
        computationAudit: children.audit,
        envelope,
      };
      const completed = await store.complete(lease, result, {
        beforePublish: () => predictionBatchDeadline(prepared.payload.batch, clock()),
      });
      if (!completed.ok) return completed;
      try {
        predictionBatchDeadline(prepared.payload.batch, clock());
      } catch (error) {
        return failure(error, id);
      }
      return { ok: true, jobId: id, status: "ready" };
    } catch (error) {
      const result = failure(error, id);
      if (!lease) return result;
      const persisted = await store.fail(lease, { code: result.code });
      return persisted.ok ? result : persisted;
    }
  }
  async function readStatus(id) {
    try {
      const prepared = await readPrepared(id);
      if (!prepared.ok) return prepared;
      if (prepared.status === "failed") return failure({ code: prepared.job.failureCode }, id);
      if (prepared.status !== "ready") return { ok: true, jobId: id, status: prepared.status };
      const ready = await store.readResult(id);
      if (!ready.ok) return ready;
      predictionBatchDeadline(prepared.payload.batch, clock());
      if (
        ready.result?.kind !== "prediction-batch-final-result" ||
        ready.result.decisionAt !== prepared.payload.batch.decisionAt
      )
        fail("RESULT_IDENTITY_MISMATCH");
      validateEnvelope(prepared.payload.batch, ready.result.envelope);
      return { ok: true, jobId: id, status: "ready", ...ready.result.envelope };
    } catch (error) {
      return failure(error, id);
    }
  }
  function listDispatchable({ limit = 25, after = null } = {}) {
    return store.listDispatchable({
      namespace: "official",
      kind: KIND,
      codeHash: expectedCodeHash,
      limit,
      after,
    });
  }
  return { enqueue, consumeOne, readStatus, listDispatchable };
}
