// Administrative projection: bounded SELECT/R2 reads, no credentials, raw logs,
// private trials or mutation of the evidence being audited.
export async function predictionRuntimeOverview({
  database,
  captureStore,
  jobStore,
  build,
  now = Date.now(),
}) {
  const heartbeat = await database
    .prepare("SELECT value_json,updated_at,expires_at FROM prediction_runtime_state WHERE key=?")
    .bind("consumer-heartbeat")
    .first();
  const jobs = await database
    .prepare(
      `SELECT CASE WHEN expires_at <= ? AND status IN ('queued','running')
    THEN 'expired' ELSE status END AS state,COUNT(*) AS count FROM prediction_jobs GROUP BY state`,
    )
    .bind(Math.floor(now / 1000))
    .all();
  const [source, attempt, receipt, index] = await Promise.all(
    ["official-universe", "source-attempt", "receipt", "replay-index"].map((type) =>
      captureStore.latest(type),
    ),
  );
  const latest = await database
    .prepare(
      "SELECT id FROM prediction_jobs WHERE prediction_id IS NOT NULL ORDER BY prediction_generated_at DESC LIMIT 1",
    )
    .bind()
    .first();
  const prediction = latest ? await jobStore.readResult(latest.id, { historical: true }) : null;
  const beat = heartbeat ? JSON.parse(heartbeat.value_json) : null;
  return {
    checkedAt: new Date(now).toISOString(),
    buildHash: build.sourceHash,
    sourceCommit: null,
    siteVersion: null,
    consumer: heartbeat
      ? {
          observedAt: new Date(heartbeat.updated_at).toISOString(),
          status: beat.status,
          trigger: beat.trigger,
          currentBuild: beat.build === build.sourceHash,
          fresh: heartbeat.expires_at > now,
        }
      : null,
    // A service/manual heartbeat cannot prove an unattended capture trigger.
    scheduler: { status: "unknown", lastVerifiedTrigger: null },
    lastRun: attempt
      ? {
          observedAt: attempt.observedAt,
          status: attempt.payload.status,
          code: attempt.payload.sourceCode || attempt.payload.result?.code || null,
        }
      : null,
    lastSuccessfulSourceReadAt: source?.observedAt || null,
    jobs: Object.fromEntries(jobs.results.map((row) => [row.state, row.count])),
    lastPersistedReceiptAt: receipt?.observedAt || null,
    indexUpdatedAt: index?.observedAt || null,
    readback: {
      captureReceipt: receipt ? "hash-verified" : "unknown",
      index: index ? "hash-verified" : "unknown",
      prediction: prediction ? (prediction.ok ? "hash-verified" : "failed") : "unknown",
    },
    productionValidation: "pending",
    pending: [
      "真实调度触发、执行、存储及读回的关联证据",
      "原站点跨设备有效版本验收",
      "部署 source commit 核对",
    ],
  };
}
