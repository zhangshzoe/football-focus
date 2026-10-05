import { createHash, randomUUID } from "node:crypto";

export const predictionRuntimeSchemaSql = `CREATE TABLE prediction_runtime_state (
  key TEXT PRIMARY KEY NOT NULL, value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`;
const failure = (code) => Object.assign(new Error(code), { code });

// Safe, read-only public projection. Never expose tokens, internal logs or jobs.
export function predictionConsumerReadiness(beat, buildIdentity, now = Date.now()) {
  const available = !!beat && beat.expires_at > now &&
    beat.value?.build === buildIdentity && beat.value?.trigger === "service" &&
    ["running", "checked"].includes(beat.value?.status);
  return {
    available,
    code: available ? null : "INDEPENDENT_CONSUMER_UNAVAILABLE",
    message: available
      ? "后台可接收预测任务；提交后仍需核验实时官方数据。"
      : "后台预测执行程序未就绪，暂不能生成新预测。请稍后检查状态；刷新比赛不能启动后台。",
  };
}

export function predictionSubmission({
  database,
  runtime,
  prepare,
  buildIdentity,
  clock = Date.now,
}) {
  const read = async (key) => {
    const row = await database
      .prepare("SELECT * FROM prediction_runtime_state WHERE key = ?")
      .bind(key)
      .first();
    return row ? { ...row, value: JSON.parse(row.value_json) } : null;
  };
  const put = (key, value, expiresAt) =>
    database
      .prepare(
        `INSERT INTO prediction_runtime_state
    (key,value_json,updated_at,expires_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET
    value_json=excluded.value_json,updated_at=excluded.updated_at,expires_at=excluded.expires_at`,
      )
      .bind(key, JSON.stringify(value), clock(), expiresAt)
      .run();

  async function submit(fixtureIds, forceRefresh = false) {
    const now = clock();
    if (
      !Array.isArray(fixtureIds) ||
      !fixtureIds.length ||
      fixtureIds.length > 120 ||
      fixtureIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 180)
    )
      throw failure("INVALID_FIXTURE_SELECTION");
    const scope =
      "submission:" +
      createHash("sha256")
        .update(JSON.stringify([buildIdentity, [...new Set(fixtureIds)].sort()]))
        .digest("hex");
    const prior = await read(scope);
    // Ordinary repeat clicks reference the same frozen quote version for at most
    // 30 seconds. An explicit quote refresh never reuses this request shortcut.
    if (!forceRefresh && prior?.expires_at > now && prior.value.jobId) {
      const state = await runtime.readStatus(prior.value.jobId);
      if (state.ok && ["queued", "running", "ready"].includes(state.status))
        return { ...state, reused: true };
    }
    const beat = await read("consumer-heartbeat");
    if (!predictionConsumerReadiness(beat, buildIdentity, now).available)
      throw failure("INDEPENDENT_CONSUMER_UNAVAILABLE");
    // Global admission lease: at most one source preparation every 10 seconds,
    // with 30 seconds for a stalled preparation. Atomic across Worker instances.
    const token = randomUUID();
    const admitted = await database
      .prepare(
        `INSERT INTO prediction_runtime_state
      (key,value_json,updated_at,expires_at) VALUES ('submission-admission',?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,
      updated_at=excluded.updated_at,expires_at=excluded.expires_at
      WHERE prediction_runtime_state.expires_at <= ? RETURNING key`,
      )
      .bind(JSON.stringify({ token }), now, now + 30000, now)
      .first();
    if (!admitted) throw failure("PREDICTION_RATE_LIMITED");
    try {
      const active = await database
        .prepare(
          `SELECT COUNT(*) AS count FROM prediction_jobs
        WHERE status IN ('queued','running') AND expires_at > ?`,
        )
        .bind(Math.floor(now / 1000))
        .first();
      if (Number(active?.count) + fixtureIds.length + 1 > 240)
        throw failure("PREDICTION_CAPACITY_REACHED");
      const prepared = JSON.parse(
        JSON.stringify(await prepare([...new Set(fixtureIds)], forceRefresh)),
      );
      // A timed-out/replaced preparer cannot submit work under someone else's lease.
      const lease = await read("submission-admission");
      if (lease?.value.token !== token || lease.expires_at <= clock())
        throw failure("PREPARATION_LEASE_EXPIRED");
      const result = await runtime.enqueue(prepared, { admissionToken: token });
      if (!result.ok) throw failure(result.code || "PREDICTION_ENQUEUE_FAILED");
      const id = result.job.id;
      await database
        .prepare(
          `INSERT INTO prediction_runtime_state (key,value_json,updated_at,expires_at)
        SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM prediction_runtime_state WHERE key='submission-admission'
          AND json_extract(value_json,'$.token')=? AND expires_at>unixepoch()*1000)
        ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,expires_at=excluded.expires_at`,
        )
        .bind(
          scope,
          JSON.stringify({ jobId: id }),
          clock(),
          Math.min(clock() + 30000, result.job.expiresAtEpoch * 1000),
          token,
        )
        .run();
      return { ...(await runtime.readStatus(id)), reused: result.reused === true };
    } finally {
      await database
        .prepare(
          `UPDATE prediction_runtime_state SET expires_at=?
        WHERE key='submission-admission' AND json_extract(value_json,'$.token')=?`,
        )
        .bind(Math.max(now + 10000, clock()), token)
        .run();
    }
  }
  return { submit, read, put };
}
