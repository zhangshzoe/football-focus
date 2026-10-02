import { createHash } from "node:crypto";
import { computePredictionUnit } from "./prediction-computation.js";
import { PREDICTION_PIPELINE_VERSION } from "./prediction-model.js";
import { resolveServerOfficialMatches } from "./server-official-evidence.js";

const POOLS = ["HAD", "HHAD", "CRS", "TTG", "HAFU"];
const HASH = /^[a-f0-9]{64}$/;
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
const fixtureId = (match) => String(match?.officialMatchId || match?.matchId || "");

// Only trusted server preparation calls enqueue. The HTTP consumer accepts an ID,
// never this payload, a quote, a model parameter, a clock or a code identity.
export function predictionUnitDeadline(prepared, now = Date.now()) {
  const unit = prepared?.unit;
  if (
    prepared?.schemaVersion !== 1 ||
    prepared.kind !== "prediction-unit-computation" ||
    unit?.schemaVersion !== 1 ||
    !["official", "research"].includes(unit.namespace) ||
    unit.modelInput?.pipelineVersion !== PREDICTION_PIPELINE_VERSION ||
    !Number.isFinite(now)
  )
    fail("INVALID_PREPARED_UNIT");
  const decision = Date.parse(unit.modelInput.decisionAt);
  if (!Number.isFinite(decision) || decision > now) fail("INVALID_DECISION_TIME");
  const deadlines = [];
  const observed = (value) => {
    const at = Date.parse(value || "");
    if (!Number.isFinite(at) || at > decision || at > now || now - at > 300000)
      fail("PREDICTION_SOURCE_EXPIRED");
    deadlines.push(at + 300000);
    return at;
  };
  if (!Array.isArray(unit.modelInput.companies) || !unit.modelInput.companies.length)
    fail("INVALID_PREPARED_UNIT");
  for (const company of unit.modelInput.companies) observed(company.fetchedAt);
  const kickoff = (value) => {
    const at = Date.parse(value || "");
    if (!Number.isFinite(at) || at <= now) fail("PREDICTION_FIXTURE_STARTED");
    deadlines.push(at);
  };
  if (unit.namespace === "official") {
    const data = prepared.officialData;
    if (
      data?.manifestState !== "complete" ||
      !Array.isArray(data.matches) ||
      !Array.isArray(prepared.selectedOfficialMatchIds) ||
      !prepared.selectedOfficialMatchIds.length ||
      prepared.selectedOfficialMatchIds.length > 120 ||
      !Array.isArray(prepared.pendingVerification) ||
      !Array.isArray(prepared.sourceFailures)
    )
      fail("OFFICIAL_PREPARATION_INCOMPLETE");
    const universe = new Map();
    for (const match of data.matches) {
      const id = fixtureId(match);
      if (!id || universe.has(id) || match.isMock) fail("OFFICIAL_PREPARATION_INCOMPLETE");
      universe.set(id, match);
    }
    const selected = prepared.selectedOfficialMatchIds;
    if (
      selected.some((id) => typeof id !== "string" || !universe.has(id)) ||
      new Set(selected).size !== selected.length ||
      !selected.includes(unit.modelInput.official?.officialMatchId)
    )
      fail("OFFICIAL_PREPARATION_INCOMPLETE");
    const fetched = observed(data.fetchedAt);
    for (const pool of POOLS) {
      if (
        data.poolStatus?.[pool]?.status !== "success" ||
        observed(data.poolStatus[pool].observedAt) > fetched
      )
        fail("OFFICIAL_MANIFEST_UNAVAILABLE");
    }
    // The whole selected scope remains visible and expires as a batch; no worker
    // quietly drops a missing/started fixture to manufacture complete coverage.
    for (const id of selected) {
      const selectedMatch = universe.get(id);
      kickoff(selectedMatch.kickoffAt);
      for (const eligibility of Object.values(selectedMatch.marketEligibility || {})) {
        if (
          eligibility.qualification === "qualified" &&
          String(eligibility.salesStatus || "")
            .trim()
            .toLowerCase() === "selling"
        ) {
          const at = Date.parse(eligibility.cutoffAt || selectedMatch.kickoffAt);
          if (!Number.isFinite(at) || at <= now) fail("PREDICTION_SALES_CLOSED");
          deadlines.push(at);
        }
      }
    }
    const match = universe.get(unit.modelInput.official.officialMatchId);
    const source = { ...data, method: "server-refetch" };
    resolveServerOfficialMatches(
      {
        officialSource: source,
        officialMatches: [match],
        reports: [
          {
            officialMatchId: fixtureId(match),
            officialMappingStatus: "verified",
            isMock: false,
            officialVerification: { method: "server-refetch", fetchedAt: data.fetchedAt },
            modelInput: unit.modelInput,
          },
        ],
      },
      [match],
      match.salesDate,
      now,
    );
  } else {
    if (
      prepared.officialData !== undefined ||
      prepared.selectedOfficialMatchIds !== undefined ||
      !prepared.researchFixture?.externalMatchId ||
      prepared.researchFixture.researchOnly !== true ||
      String(unit.modelInput.official?.officialMatchId || "") ||
      !unit.scope ||
      unit.teamOptions != null
    )
      fail("RESEARCH_SCOPE_INVALID");
    observed(prepared.researchFixture.fetchedAt);
    kickoff(prepared.researchFixture.kickoffAt);
  }
  const deadline = Math.floor(Math.min(...deadlines) / 1000);
  if (deadline * 1000 <= now) fail("PREDICTION_SOURCE_EXPIRED");
  return deadline;
}

export function createPredictionUnitRuntime({
  store,
  codeIdentity,
  clock = Date.now,
  compute = computePredictionUnit,
}) {
  if (
    codeIdentity?.schemaVersion !== 1 ||
    !HASH.test(codeIdentity.sourceHash || "") ||
    !codeIdentity.files ||
    !Object.keys(codeIdentity.files).length ||
    Object.values(codeIdentity.files).some((hash) => !HASH.test(hash)) ||
    typeof compute !== "function" ||
    typeof clock !== "function"
  )
    fail("INVALID_PREDICTION_BUILD_IDENTITY");
  // Retain a private transport snapshot; a caller cannot mutate the build that
  // this runtime will enqueue after its fingerprint has already been checked.
  const frozenCodeIdentity = JSON.parse(JSON.stringify(codeIdentity));
  const codeFingerprint = fingerprint(frozenCodeIdentity);
  const sameBuild = (job) => {
    if (fingerprint(job.codeIdentity) !== codeFingerprint) fail("PREDICTION_BUILD_CHANGED");
  };
  const failure = (error, jobId) => ({
    ok: false,
    jobId,
    status: "failed",
    code: /^[A-Z][A-Z0-9_]{1,79}$/.test(error?.code || "") ? error.code : "PREDICTION_UNIT_FAILED",
  });

  async function enqueue(prepared) {
    // Freeze before the first asynchronous storage operation, not after it.
    prepared = structuredClone(prepared);
    const expiresAtEpoch = predictionUnitDeadline(prepared, clock());
    const unit = prepared.unit;
    const inputIdentity = {
      schemaVersion: 1,
      kind: "prediction-unit-computation",
      namespace: unit.namespace,
      fixtureId:
        unit.namespace === "official"
          ? unit.modelInput.official.officialMatchId
          : prepared.researchFixture.externalMatchId,
      decisionAt: unit.modelInput.decisionAt,
      scope: unit.scope || "official",
      calibrationId: unit.calibrationId || "cal-none",
    };
    const pointer = await store.persistPrepared({
      namespace: unit.namespace,
      inputIdentity,
      payload: prepared,
    });
    if (!pointer.ok) return pointer;
    // Source time did not slide during object writes. SQL uses this absolute
    // deadline, including after every subsequent R2 or D1 await.
    predictionUnitDeadline(prepared, clock());
    const result = await store.enqueue({
      namespace: unit.namespace,
      inputIdentity,
      codeIdentity: frozenCodeIdentity,
      prepared: pointer,
      expiresAtEpoch,
    });
    predictionUnitDeadline(prepared, clock());
    return result;
  }

  async function consumeOne(selector = {}) {
    const { id, namespace = "official" } = selector;
    // With an ID there is no namespace selection. Reject ambiguous selectors
    // before acquiring a lease or performing any numerical work.
    if (id && selector.namespace !== undefined)
      return { ok: false, status: "failed", code: "AMBIGUOUS_TASK_SELECTOR" };
    const kind = "prediction-unit-computation";
    const claimed = id
      ? await store.claim({ id, kind })
      : await store.claimNext({ namespace, kind });
    if (!claimed.ok || !claimed.claimed) return claimed;
    const { job, lease } = claimed;
    try {
      sameBuild(job);
      const prepared = await store.readPrepared(job.id);
      if (!prepared.ok) return prepared;
      if (prepared.payload.unit.namespace !== job.namespace) fail("PREPARED_IDENTITY_MISMATCH");
      predictionUnitDeadline(prepared.payload, clock());
      const computationStartedAt = new Date(clock()).toISOString();
      // Exactly one fixture per independently invoked consumer. Submission and
      // status never call this method or schedule it through waitUntil/Promise.
      const output = compute(prepared.payload.unit);
      if (!output || typeof output !== "object" || typeof output.then === "function")
        fail("INVALID_COMPUTATION_OUTPUT");
      const computationCompletedAt = new Date(clock()).toISOString();
      predictionUnitDeadline(prepared.payload, clock());
      const completed = await store.complete(
        lease,
        {
          schemaVersion: 1,
          kind: "prediction-unit-numerical-result",
          decisionAt: prepared.payload.unit.modelInput.decisionAt,
          computationStartedAt,
          computationCompletedAt,
          output,
        },
        { beforePublish: () => predictionUnitDeadline(prepared.payload, clock()) },
      );
      if (!completed.ok) return completed;
      // SQL fences publication against its own clock. Its reply can arrive
      // later, so do not advertise a now-stale numerical success to the caller.
      // The immutable ready object is preserved, not rewritten as a failure.
      try {
        predictionUnitDeadline(prepared.payload, clock());
      } catch (error) {
        return failure(error, job.id);
      }
      return completed;
    } catch (error) {
      const result = failure(error, job.id);
      const persisted = await store.fail(lease, { code: result.code });
      return persisted.ok ? { ...result, job: persisted.job } : persisted;
    }
  }

  async function readStatus(id, { includePrepared = false } = {}) {
    const current = await store.read(id);
    if (!current.ok) return current;
    try {
      sameBuild(current.job);
      const prepared = await store.readPrepared(id);
      if (!prepared.ok) return prepared;
      predictionUnitDeadline(prepared.payload, clock());
      if (current.status === "failed")
        return { ok: false, jobId: id, status: "failed", code: current.job.failureCode };
      if (["queued", "running"].includes(current.status))
        return { ok: true, jobId: id, status: current.status, numericalOnly: true };
      const ready = await store.readResult(id);
      if (!ready.ok) return ready;
      predictionUnitDeadline(prepared.payload, clock());
      if (
        ready.result?.kind !== "prediction-unit-numerical-result" ||
        ready.result.decisionAt !== prepared.payload.unit.modelInput.decisionAt
      )
        fail("RESULT_IDENTITY_MISMATCH");
      // Not the signed, complete batch envelope. A numerical unit cannot be
      // adopted by existing capture/ticket callers as a formal prediction.
      return {
        ok: true,
        jobId: id,
        status: "ready",
        numericalOnly: true,
        result: ready.result,
        ...(includePrepared ? { prepared: prepared.payload } : {}),
      };
    } catch (error) {
      return failure(error, id);
    }
  }
  return { enqueue, consumeOne, readStatus };
}
