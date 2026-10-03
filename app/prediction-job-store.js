import { createHash, randomUUID } from "node:crypto";

const NAMESPACES = new Set(["official", "research"]);
const STATES = new Set(["queued", "running", "ready", "failed", "expired"]);
const MAX_OBJECT_BYTES = 16 * 1024 * 1024;
const MAX_IDENTITY_BYTES = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const JOB_ID = /^prediction-[a-f0-9]{64}$/;
const CREDENTIAL_KEY =
  /^(?:authorization|cookie|setcookie|password|secret|token|apikey|accesskey|accesstoken|refreshtoken|usertoken|bearertoken|sessiontoken|credentials)$|(?:apikey|signingkey|capturetoken|secret)$/i;

function invalid(code) {
  const error = new TypeError(code);
  error.code = code;
  return error;
}

// Preserve every JSON value in the identity. Unsupported values are rejected,
// rather than silently discarded while fingerprinting a supposedly complete input.
function canonical(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (!value || typeof value !== "object" || seen.has(value)) throw invalid("INVALID_JSON_PAYLOAD");
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw invalid("INVALID_JSON_PAYLOAD");
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = Array.from(value, (entry) => canonical(entry, seen));
  } else {
    result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (CREDENTIAL_KEY.test(key.replaceAll(/[-_]/g, "")))
        throw invalid("CREDENTIAL_STORAGE_FORBIDDEN");
      result[key] = canonical(value[key], seen);
    }
  }
  seen.delete(value);
  return result;
}

const json = (value) => JSON.stringify(canonical(value));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const byteLength = (bytes) => new TextEncoder().encode(bytes).length;
const objectKey = (namespace, kind, contentHash) =>
  `prediction-jobs/${namespace}/${kind}/${contentHash}.json`;
function namespaceValue(namespace) {
  if (!NAMESPACES.has(namespace)) throw invalid("INVALID_JOB_NAMESPACE");
  return namespace;
}
function kindValue(kind) {
  if (kind !== null && (typeof kind !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(kind)))
    throw invalid("INVALID_JOB_KIND");
  return kind;
}
function identityJson(value, code) {
  if (!value || Array.isArray(value) || typeof value !== "object" || !Object.keys(value).length)
    throw invalid(code);
  const bytes = json(value);
  if (byteLength(bytes) > MAX_IDENTITY_BYTES) throw invalid(code);
  return bytes;
}
function seconds(value, maximum, code) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw invalid(code);
  return value;
}
function idValue(id) {
  if (typeof id !== "string" || !JOB_ID.test(id)) throw invalid("INVALID_JOB_ID");
  return id;
}
function leaseValue(lease) {
  if (
    !lease ||
    !JOB_ID.test(lease.jobId || "") ||
    typeof lease.token !== "string" ||
    !/^[a-f0-9-]{36}$/.test(lease.token) ||
    !Number.isSafeInteger(lease.fence) ||
    lease.fence < 1
  )
    throw invalid("INVALID_JOB_LEASE");
  return lease;
}

/**
 * Deployment must execute these statements as a migration. Creating a store or
 * using it never creates tables, touches research evidence, or acquires its lock.
 */
export function predictionJobSchemaSql() {
  return [
    `CREATE TABLE prediction_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      namespace TEXT NOT NULL CHECK(namespace IN ('official', 'research')),
      input_fingerprint TEXT NOT NULL,
      input_identity_json TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      code_identity_json TEXT NOT NULL,
      prepared_object_key TEXT NOT NULL,
      prepared_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'ready', 'failed', 'expired')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK(expires_at > created_at),
      first_started_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      owner_token TEXT,
      fence INTEGER NOT NULL DEFAULT 0 CHECK(fence >= 0),
      lease_until INTEGER,
      result_object_key TEXT,
      result_hash TEXT,
      failure_code TEXT,
      prediction_id TEXT,
      prediction_sales_dates TEXT,
      prediction_generated_at TEXT,
      UNIQUE(namespace, input_fingerprint, code_identity_json),
      CHECK((status = 'running' AND owner_token IS NOT NULL AND lease_until IS NOT NULL)
        OR (status != 'running' AND owner_token IS NULL AND lease_until IS NULL)),
      CHECK((result_object_key IS NULL) = (result_hash IS NULL)),
      CHECK(status != 'ready' OR (result_object_key IS NOT NULL AND completed_at IS NOT NULL))
    )`,
    "CREATE INDEX idx_prediction_jobs_claim ON prediction_jobs(namespace, status, expires_at, lease_until, created_at, id)",
    "CREATE INDEX idx_prediction_jobs_expiry ON prediction_jobs(expires_at, status)",
    "CREATE INDEX idx_prediction_jobs_version ON prediction_jobs(prediction_id)",
    "CREATE INDEX idx_prediction_jobs_latest ON prediction_jobs(namespace, prediction_generated_at)",
  ];
}

/** Entire caller-supplied code identity participates; a display version alone is insufficient. */
export function predictionJobIdentity({ namespace, inputIdentity, codeIdentity, preparedHash }) {
  namespaceValue(namespace);
  if (!HASH.test(preparedHash || "")) throw invalid("INVALID_PREPARED_HASH");
  const inputIdentityJson = identityJson(inputIdentity, "INVALID_INPUT_IDENTITY");
  const codeIdentityJson = identityJson(codeIdentity, "INVALID_CODE_IDENTITY");
  const inputFingerprint = hash(
    json({ inputIdentity: JSON.parse(inputIdentityJson), preparedHash }),
  );
  const codeHash = hash(codeIdentityJson);
  const id = `prediction-${hash(json({ schemaVersion: 1, namespace, inputFingerprint, codeIdentity: JSON.parse(codeIdentityJson) }))}`;
  return { id, inputFingerprint, codeHash, inputIdentityJson, codeIdentityJson };
}

/**
 * D1 prepare/bind/first/run and R2 get/put are the real binding interfaces.
 * The only stored token is a server-generated worker lease token, never an HTTP
 * credential. This core stores supplied data; it does not fetch or run a model.
 */
export function createPredictionJobStore({ database, objects }) {
  if (
    typeof database?.prepare !== "function" ||
    typeof objects?.get !== "function" ||
    typeof objects?.put !== "function"
  )
    throw invalid("PREDICTION_JOB_STORAGE_UNAVAILABLE");
  // Primary-anchored sequential consistency prevents a replica from hiding a
  // preceding enqueue/claim. The project SQLite fixture has no session method.
  const db =
    typeof database.withSession === "function" ? database.withSession("first-primary") : database;
  const statement = (sql, values = []) => db.prepare(sql).bind(...values);
  const select = (id) =>
    statement("SELECT *, unixepoch() AS database_now FROM prediction_jobs WHERE id = ?", [
      id,
    ]).first();
  const expireId = (id) =>
    statement(
      `UPDATE prediction_jobs SET status = 'expired', updated_at = unixepoch(),
    owner_token = NULL, lease_until = NULL WHERE id = ? AND expires_at <= unixepoch() AND status != 'expired'`,
      [id],
    ).run();
  const load = async (id) => {
    await expireId(id);
    return select(id);
  };
  const iso = (at) => (at == null ? null : new Date(Number(at) * 1000).toISOString());
  function jobValue(row) {
    if (!row) return null;
    return {
      id: row.id,
      namespace: row.namespace,
      status: row.expires_at <= row.database_now ? "expired" : row.status,
      inputFingerprint: row.input_fingerprint,
      inputIdentity: JSON.parse(row.input_identity_json),
      codeHash: row.code_hash,
      codeIdentity: JSON.parse(row.code_identity_json),
      prepared: { objectKey: row.prepared_object_key, contentHash: row.prepared_hash },
      result: row.result_hash
        ? { objectKey: row.result_object_key, contentHash: row.result_hash }
        : null,
      predictionId: row.prediction_id || null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      expiresAt: iso(row.expires_at),
      expiresAtEpoch: row.expires_at,
      firstStartedAt: iso(row.first_started_at),
      startedAt: iso(row.started_at),
      completedAt: iso(row.completed_at),
      fence: row.fence,
      leaseUntil: iso(row.lease_until),
      failureCode: row.failure_code,
    };
  }
  function outcome(row, extra = {}) {
    const job = jobValue(row);
    if (!job) return { ok: false, status: null, job: null, code: "JOB_NOT_FOUND", ...extra };
    if (!STATES.has(job.status))
      return { ok: false, status: job.status, job, code: "INVALID_JOB_STATE", ...extra };
    if (job.status === "expired")
      return { ok: false, status: "expired", job, code: "JOB_EXPIRED", ...extra };
    return { ok: true, status: job.status, job, ...extra };
  }
  function refused(row, lease) {
    const result = outcome(row);
    if (!result.ok) return result;
    if (row.status !== "running")
      return { ...result, ok: false, code: `JOB_${row.status.toUpperCase()}` };
    if (
      row.owner_token !== lease.token ||
      row.fence !== lease.fence ||
      row.lease_until <= row.database_now
    )
      return { ...result, ok: false, code: "LEASE_LOST" };
    return null;
  }
  const leaseFor = (row) => ({
    jobId: row.id,
    token: row.owner_token,
    fence: row.fence,
    leaseUntil: row.lease_until,
  });

  async function readObject(pointer) {
    const object = await objects.get(pointer.objectKey);
    if (!object) return { ok: false, code: "OBJECT_MISSING" };
    let value, bytes;
    try {
      const raw = await object.text();
      if (byteLength(raw) > MAX_OBJECT_BYTES) return { ok: false, code: "OBJECT_TOO_LARGE" };
      value = JSON.parse(raw);
      bytes = json(value);
    } catch {
      return { ok: false, code: "OBJECT_INVALID" };
    }
    if (hash(bytes) !== pointer.contentHash) return { ok: false, code: "OBJECT_HASH_MISMATCH" };
    return { ok: true, value };
  }
  async function persist(namespace, kind, value) {
    const bytes = json(value);
    if (byteLength(bytes) > MAX_OBJECT_BYTES) throw invalid("JOB_OBJECT_TOO_LARGE");
    const pointer = {
      objectKey: objectKey(namespace, kind, hash(bytes)),
      contentHash: hash(bytes),
    };
    const existing = await objects.get(pointer.objectKey);
    if (!existing)
      await objects.put(pointer.objectKey, bytes, {
        onlyIf: new Headers({ "If-None-Match": "*" }),
        httpMetadata: { contentType: "application/json" },
      });
    const verified = await readObject(pointer);
    if (!verified.ok) return { ...verified, pointer };
    return { ok: true, ...pointer };
  }
  async function persistPrepared({ namespace, inputIdentity, payload }) {
    namespaceValue(namespace);
    const inputIdentityJson = identityJson(inputIdentity, "INVALID_INPUT_IDENTITY");
    const saved = await persist(namespace, "prepared", {
      schemaVersion: 1,
      kind: "prediction-job-prepared",
      namespace,
      inputIdentity: JSON.parse(inputIdentityJson),
      payload,
    });
    if (!saved.ok) return saved;
    const inputFingerprint = hash(
      json({ inputIdentity: JSON.parse(inputIdentityJson), preparedHash: saved.contentHash }),
    );
    return { ...saved, namespace, inputIdentity: JSON.parse(inputIdentityJson), inputFingerprint };
  }
  async function enqueue({
    namespace,
    inputIdentity,
    codeIdentity,
    prepared,
    ttlSeconds = 900,
    expiresAtEpoch = null,
    admissionToken = null,
  }) {
    if (admissionToken !== null && !/^[a-f0-9-]{36}$/.test(admissionToken)) throw invalid("INVALID_ADMISSION_TOKEN");
    namespaceValue(namespace);
    seconds(ttlSeconds, 604800, "INVALID_JOB_TTL");
    if (expiresAtEpoch !== null && (!Number.isSafeInteger(expiresAtEpoch) || expiresAtEpoch < 1))
      throw invalid("INVALID_JOB_DEADLINE");
    if (
      !prepared ||
      !HASH.test(prepared.contentHash || "") ||
      prepared.objectKey !== objectKey(namespace, "prepared", prepared.contentHash)
    )
      throw invalid("INVALID_PREPARED_POINTER");
    const identity = predictionJobIdentity({
      namespace,
      inputIdentity,
      codeIdentity,
      preparedHash: prepared.contentHash,
    });
    const verified = await readObject(prepared);
    if (!verified.ok)
      return {
        ok: false,
        status: null,
        enqueued: false,
        job: null,
        code: `PREPARED_${verified.code}`,
      };
    const value = verified.value;
    if (
      value.schemaVersion !== 1 ||
      value.kind !== "prediction-job-prepared" ||
      value.namespace !== namespace ||
      json(value.inputIdentity) !== identity.inputIdentityJson ||
      !Object.hasOwn(value, "payload")
    )
      return {
        ok: false,
        status: null,
        enqueued: false,
        job: null,
        code: "PREPARED_IDENTITY_MISMATCH",
      };
    const inserted = await statement(
      `INSERT INTO prediction_jobs
      (id, namespace, input_fingerprint, input_identity_json, code_hash, code_identity_json,
       prepared_object_key, prepared_hash, status, created_at, updated_at, expires_at, fence)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'queued', unixepoch(), unixepoch(),
        min(unixepoch() + ?, coalesce(?, unixepoch() + ?)), 0
      WHERE coalesce(?, unixepoch() + ?) > unixepoch()
      ${admissionToken ? "AND EXISTS (SELECT 1 FROM prediction_runtime_state WHERE key='submission-admission' AND json_extract(value_json,'$.token')=? AND expires_at>unixepoch()*1000)" : ""}
      ON CONFLICT DO NOTHING`,
      [
        identity.id,
        namespace,
        identity.inputFingerprint,
        identity.inputIdentityJson,
        identity.codeHash,
        identity.codeIdentityJson,
        prepared.objectKey,
        prepared.contentHash,
        ttlSeconds,
        expiresAtEpoch,
        ttlSeconds,
        expiresAtEpoch,
        ttlSeconds,
        ...(admissionToken ? [admissionToken] : []),
      ],
    ).run();
    const row = await load(identity.id);
    if (!row && admissionToken) return { ok: false, status: "failed", job: null, enqueued: false, code: "PREPARATION_LEASE_EXPIRED" };
    if (!row && expiresAtEpoch !== null)
      return { ok: false, status: "expired", job: null, enqueued: false, code: "JOB_EXPIRED" };
    if (
      row &&
      (row.namespace !== namespace ||
        row.input_fingerprint !== identity.inputFingerprint ||
        row.code_hash !== identity.codeHash ||
        row.input_identity_json !== identity.inputIdentityJson ||
        row.code_identity_json !== identity.codeIdentityJson ||
        row.prepared_object_key !== prepared.objectKey ||
        row.prepared_hash !== prepared.contentHash)
    )
      return {
        ok: false,
        status: row.status,
        job: jobValue(row),
        enqueued: false,
        code: "JOB_IDENTITY_CONFLICT",
      };
    return outcome(row, { enqueued: Number(inserted.meta?.changes || 0) === 1 });
  }
  // Polling is SELECT-only: expiry is derived from the database clock and is
  // persisted only by authorized enqueue/claim/worker mutation paths.
  async function read(id) {
    return outcome(await select(idValue(id)));
  }
  async function readPrepared(id) {
    const current = await read(id);
    if (!current.ok) return current;
    const verified = await readObject(current.job.prepared);
    if (!verified.ok) return { ...current, ok: false, code: `PREPARED_${verified.code}` };
    const value = verified.value;
    if (
      value.schemaVersion !== 1 ||
      value.kind !== "prediction-job-prepared" ||
      value.namespace !== current.job.namespace ||
      json(value.inputIdentity) !== json(current.job.inputIdentity) ||
      !Object.hasOwn(value, "payload")
    )
      return { ...current, ok: false, code: "PREPARED_IDENTITY_MISMATCH" };
    const latest = await read(id);
    if (!latest.ok) return latest;
    // Business freshness and official proof must be checked by the real consumer.
    return { ...latest, payload: value.payload };
  }
  async function readResult(id, { historical = false } = {}) {
    const raw = historical ? await select(idValue(id)) : null;
    const current = historical && raw?.result_hash && raw.completed_at
      ? { ok: true, status: "ready", job: jobValue(raw) }
      : await read(id);
    if (!current.ok) return current;
    if (current.status !== "ready")
      return { ...current, ok: false, code: `JOB_${current.status.toUpperCase()}` };
    const verified = await readObject(current.job.result);
    if (!verified.ok) return { ...current, ok: false, code: `RESULT_${verified.code}` };
    const value = verified.value;
    if (
      value.schemaVersion !== 1 ||
      value.kind !== "prediction-job-result" ||
      value.jobId !== id ||
      value.namespace !== current.job.namespace ||
      value.inputFingerprint !== current.job.inputFingerprint ||
      value.codeHash !== current.job.codeHash ||
      !Object.hasOwn(value, "result")
    )
      return { ...current, ok: false, code: "RESULT_IDENTITY_MISMATCH" };
    const latest = historical ? current : await read(id);
    if (!latest.ok) return latest;
    return { ...latest, result: value.result };
  }
  // Only completed official batch results are indexed. This query never claims
  // jobs or fits probabilities, and history remains readable after expiry.
  async function findPredictionVersions({ predictionId, salesDate, limit = 25, offset = 0 }) {
    if ((predictionId && (typeof predictionId !== "string" || predictionId.length > 180)) ||
      (salesDate && !/^\d{4}-\d{2}-\d{2}$/.test(salesDate)) ||
      (!predictionId && !salesDate) || !Number.isInteger(limit) || limit < 1 || limit > 25 ||
      !Number.isInteger(offset) || offset < 0 || offset > 1000) throw invalid("INVALID_VERSION_QUERY");
    const rows = await statement(`SELECT id FROM prediction_jobs
      WHERE namespace = 'official' AND result_hash IS NOT NULL AND completed_at IS NOT NULL
        AND prediction_id IS NOT NULL
        AND (? IS NULL OR prediction_id = ?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(prediction_sales_dates) WHERE value = ?))
      ORDER BY prediction_generated_at DESC, id DESC LIMIT ? OFFSET ?`,
      [predictionId || null, predictionId || null, salesDate || null, salesDate || null, limit, offset]).all();
    return (rows.results || []).map(row => row.id);
  }
  async function claim({ id, kind = null, codeHash = null, leaseSeconds = 120 }) {
    idValue(id);
    kindValue(kind);
    if (codeHash !== null && (typeof codeHash !== "string" || !HASH.test(codeHash)))
      throw invalid("INVALID_CODE_IDENTITY");
    seconds(leaseSeconds, 600, "INVALID_LEASE_SECONDS");
    await expireId(id);
    const row = await statement(
      `UPDATE prediction_jobs SET status = 'running', owner_token = ?, fence = fence + 1,
      lease_until = min(unixepoch() + ?, expires_at), first_started_at = coalesce(first_started_at, unixepoch()),
      started_at = unixepoch(), updated_at = unixepoch()
      WHERE id = ? AND expires_at > unixepoch()
        AND (? IS NULL OR json_extract(input_identity_json, '$.kind') = ?)
        AND (? IS NULL OR code_hash = ?)
        AND (status = 'queued' OR (status = 'running' AND lease_until <= unixepoch()))
      RETURNING *, unixepoch() AS database_now`,
      [randomUUID(), leaseSeconds, id, kind, kind, codeHash, codeHash],
    ).first();
    if (row) return outcome(row, { claimed: true, lease: leaseFor(row) });
    const current = outcome(await load(id), { claimed: false });
    if (current.ok && kind !== null && current.job.inputIdentity.kind !== kind)
      return { ...current, ok: false, code: "JOB_KIND_MISMATCH" };
    if (current.ok && codeHash !== null && current.job.codeHash !== codeHash)
      return { ...current, ok: false, code: "PREDICTION_BUILD_CHANGED" };
    return current.ok
      ? {
          ...current,
          code: `JOB_${current.status === "running" ? "BUSY" : current.status.toUpperCase()}`,
        }
      : current;
  }
  // A durable outbox view, not a claim. Dispatchers can restart with no local
  // job IDs and page past pending parents without mutating any task or clock.
  async function listDispatchable({ namespace, kind, codeHash, limit = 25, after = null }) {
    namespaceValue(namespace);
    kindValue(kind);
    if (kind === null || kind === undefined) throw invalid("INVALID_JOB_KIND");
    if (typeof codeHash !== "string" || !HASH.test(codeHash))
      throw invalid("INVALID_CODE_IDENTITY");
    seconds(limit, 25, "INVALID_DISPATCH_LIMIT");
    if (
      after !== null &&
      (!after ||
        Array.isArray(after) ||
        Object.keys(after).length !== 2 ||
        !Number.isSafeInteger(after.createdAtEpoch) ||
        after.createdAtEpoch < 0 ||
        typeof after.id !== "string" ||
        !JOB_ID.test(after.id))
    )
      throw invalid("INVALID_DISPATCH_CURSOR");
    const values = [namespace, kind, codeHash];
    const cursorSql = after ? "AND (created_at > ? OR (created_at = ? AND id > ?))" : "";
    if (after) values.push(after.createdAtEpoch, after.createdAtEpoch, after.id);
    values.push(limit + 1);
    const rows = (
      await statement(
        `SELECT id, created_at AS createdAtEpoch FROM prediction_jobs
       WHERE namespace = ? AND json_extract(input_identity_json, '$.kind') = ?
         AND code_hash = ? AND expires_at > unixepoch()
         AND (status = 'queued' OR (status = 'running' AND lease_until <= unixepoch()))
         ${cursorSql} ORDER BY created_at, id LIMIT ?`,
        values,
      ).all()
    ).results;
    const jobs = rows.slice(0, limit).map(({ id, createdAtEpoch }) => ({ id, createdAtEpoch }));
    return { jobs, nextCursor: rows.length > limit ? jobs.at(-1) : null };
  }
  async function claimNext({ namespace, kind = null, codeHash = null, leaseSeconds = 120 }) {
    namespaceValue(namespace);
    kindValue(kind);
    if (codeHash !== null && (typeof codeHash !== "string" || !HASH.test(codeHash)))
      throw invalid("INVALID_CODE_IDENTITY");
    seconds(leaseSeconds, 600, "INVALID_LEASE_SECONDS");
    const row = await statement(
      `UPDATE prediction_jobs SET status = 'running', owner_token = ?, fence = fence + 1,
      lease_until = min(unixepoch() + ?, expires_at), first_started_at = coalesce(first_started_at, unixepoch()),
      started_at = unixepoch(), updated_at = unixepoch()
      WHERE id = (SELECT id FROM prediction_jobs WHERE namespace = ? AND expires_at > unixepoch()
        AND (? IS NULL OR json_extract(input_identity_json, '$.kind') = ?)
        AND (? IS NULL OR code_hash = ?)
        AND (status = 'queued' OR (status = 'running' AND lease_until <= unixepoch())) ORDER BY created_at, id LIMIT 1)
        AND (? IS NULL OR code_hash = ?)
        AND expires_at > unixepoch() AND (status = 'queued' OR (status = 'running' AND lease_until <= unixepoch()))
      RETURNING *, unixepoch() AS database_now`,
      [randomUUID(), leaseSeconds, namespace, kind, kind, codeHash, codeHash, codeHash, codeHash],
    ).first();
    return row
      ? outcome(row, { claimed: true, lease: leaseFor(row) })
      : { ok: true, status: null, claimed: false, job: null, code: "NO_RUNNABLE_JOB" };
  }
  async function renew(lease, { leaseSeconds = 120 } = {}) {
    leaseValue(lease);
    seconds(leaseSeconds, 600, "INVALID_LEASE_SECONDS");
    const row = await statement(
      `UPDATE prediction_jobs SET lease_until = min(unixepoch() + ?, expires_at), updated_at = unixepoch()
      WHERE id = ? AND status = 'running' AND owner_token = ? AND fence = ?
        AND lease_until > unixepoch() AND expires_at > unixepoch()
      RETURNING *, unixepoch() AS database_now`,
      [leaseSeconds, lease.jobId, lease.token, lease.fence],
    ).first();
    if (row) return outcome(row, { lease: leaseFor(row) });
    const current = await load(lease.jobId);
    return refused(current, lease) || { ...outcome(current), ok: false, code: "LEASE_LOST" };
  }
  async function complete(lease, resultPayload, { beforePublish } = {}) {
    leaseValue(lease);
    if (beforePublish !== undefined && typeof beforePublish !== "function")
      throw invalid("INVALID_PUBLICATION_GUARD");
    const current = await load(lease.jobId),
      denied = refused(current, lease);
    if (denied) return denied;
    const saved = await persist(current.namespace, "results", {
      schemaVersion: 1,
      kind: "prediction-job-result",
      jobId: current.id,
      namespace: current.namespace,
      inputFingerprint: current.input_fingerprint,
      codeHash: current.code_hash,
      result: resultPayload,
    });
    if (!saved.ok) return { ...outcome(current), ok: false, code: `RESULT_${saved.code}` };
    // Runtime qualification is distinct from numerical completion. The absolute
    // deadline in expires_at also guards the later SQL await, not just this hook.
    if (beforePublish) await beforePublish();
    // The lease can expire while R2 is awaited. Only this atomic statement may
    // publish the pointer; a losing worker's orphan object is never a ready job.
    const envelope = current.namespace === "official" && resultPayload?.kind === "prediction-batch-final-result"
      ? resultPayload.envelope : null;
    const indexed = envelope?.predictionId && envelope.predictionId === envelope.version?.predictionId &&
      Array.isArray(envelope.reports) && envelope.reports.length &&
      envelope.reports.every(report => report.predictionId === envelope.predictionId && /^\d{4}-\d{2}-\d{2}$/.test(report.salesDate));
    const row = await statement(
      `UPDATE prediction_jobs SET status = 'ready', result_object_key = ?, result_hash = ?,
      prediction_id = ?, prediction_sales_dates = ?, prediction_generated_at = ?,
      completed_at = unixepoch(), updated_at = unixepoch(), owner_token = NULL, lease_until = NULL
      WHERE id = ? AND status = 'running' AND owner_token = ? AND fence = ?
        AND lease_until > unixepoch() AND expires_at > unixepoch()
      RETURNING *, unixepoch() AS database_now`,
      [saved.objectKey, saved.contentHash, indexed ? envelope.predictionId : null,
        indexed ? JSON.stringify([...new Set(envelope.reports.map(report => report.salesDate))].sort()) : null,
        indexed ? envelope.version.generatedAt : null, lease.jobId, lease.token, lease.fence],
    ).first();
    if (row) return outcome(row);
    const latest = await load(lease.jobId);
    return refused(latest, lease) || { ...outcome(latest), ok: false, code: "LEASE_LOST" };
  }
  async function fail(lease, { code }) {
    leaseValue(lease);
    if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]{1,79}$/.test(code))
      throw invalid("INVALID_FAILURE_CODE");
    const row = await statement(
      `UPDATE prediction_jobs SET status = 'failed', failure_code = ?, completed_at = unixepoch(),
      updated_at = unixepoch(), owner_token = NULL, lease_until = NULL
      WHERE id = ? AND status = 'running' AND owner_token = ? AND fence = ?
        AND lease_until > unixepoch() AND expires_at > unixepoch()
      RETURNING *, unixepoch() AS database_now`,
      [code, lease.jobId, lease.token, lease.fence],
    ).first();
    if (row) return outcome(row);
    const current = await load(lease.jobId);
    return refused(current, lease) || { ...outcome(current), ok: false, code: "LEASE_LOST" };
  }
  // Cancelling an HTTP wait is local to that caller. There is deliberately no
  // shared-job cancellation, delete, requeue, sliding-expiry, or evidence API.
  return {
    persistPrepared,
    enqueue,
    read,
    readPrepared,
    readResult,
    findPredictionVersions,
    claim,
    claimNext,
    listDispatchable,
    renew,
    complete,
    fail,
  };
}
