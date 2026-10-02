const JOB_ID = /^prediction-[a-f0-9]{64}$/;
const failure = (code) => Object.assign(new Error(code), { code });
const cursorValid = (cursor) =>
  cursor === null ||
  (cursor &&
    !Array.isArray(cursor) &&
    Object.keys(cursor).length === 2 &&
    JOB_ID.test(cursor.id || "") &&
    Number.isSafeInteger(cursor.createdAtEpoch) &&
    cursor.createdAtEpoch >= 0);

// Only an external authorized driver imports this module. Each numerical unit
// and parent aggregation is a separate HTTP invocation with a persisted ID.
// Closing the submitting request does not erase the durable recovery outbox.
export async function drainPredictionOutbox({
  origin,
  token,
  fetchImpl = fetch,
  namespace = "official",
  concurrency = 2,
  maxTasksPerLane = 120,
  deadlineMs = Date.now() + 90000,
  signal,
  cursors = { unit: null, batch: null },
}) {
  const base = new URL(origin);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      )) ||
    typeof token !== "string" ||
    token.length < 32 ||
    !["official", "research"].includes(namespace) ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 4 ||
    !Number.isInteger(maxTasksPerLane) ||
    maxTasksPerLane < 1 ||
    maxTasksPerLane > 120 ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs <= Date.now() ||
    !cursorValid(cursors.unit) ||
    !cursorValid(cursors.batch)
  )
    throw failure("INVALID_OUTBOX_DRIVER");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || failure("OUTBOX_ABORTED"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(failure("OUTBOX_DEADLINE")),
    Math.min(deadlineMs - Date.now(), 2147483647),
  );
  const guard = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (Date.now() >= deadlineMs) throw failure("OUTBOX_DEADLINE");
  };
  const call = async (path, body) => {
    guard();
    const operation = (async () => {
      const response = await fetchImpl(new URL(path, base), {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 401 || response.status === 403) throw failure("OUTBOX_UNAUTHORIZED");
      const data = await response.json();
      if (!data || Array.isArray(data) || typeof data !== "object")
        throw failure("OUTBOX_RESPONSE_INVALID");
      if (!body && !response.ok) throw failure("OUTBOX_SCAN_FAILED");
      return data;
    })();
    const result = await new Promise((resolve, reject) => {
      const cancel = () => {
        controller.signal.removeEventListener("abort", cancel);
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      operation
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener("abort", cancel));
      if (controller.signal.aborted) cancel();
    });
    guard();
    return result;
  };
  const lanes = {};
  try {
    for (const kind of namespace === "official" ? ["unit", "batch"] : ["unit"]) {
      let after = cursors[kind],
        examined = 0;
      const results = [],
        seen = new Set();
      for (;;) {
        const limit = Math.min(25, maxTasksPerLane - examined);
        const query = new URLSearchParams({ kind, namespace, limit: String(limit) });
        if (after) query.set("cursor", JSON.stringify(after));
        const page = await call(`/api/prediction-dispatch?${query}`);
        if (
          page.kind !== kind ||
          page.namespace !== namespace ||
          !Array.isArray(page.jobs) ||
          page.jobs.length > limit ||
          !cursorValid(page.nextCursor) ||
          page.jobs.some((job) => !job || !cursorValid(job) || seen.has(job.id)) ||
          (page.nextCursor &&
            (!page.jobs.length ||
              page.nextCursor.id !== page.jobs.at(-1).id ||
              page.nextCursor.createdAtEpoch !== page.jobs.at(-1).createdAtEpoch))
        )
          throw failure("OUTBOX_SCAN_INVALID");
        let index = 0;
        const consume = async () => {
          while (index < page.jobs.length) {
            guard();
            const job = page.jobs[index++];
            seen.add(job.id);
            const result = await call(
              kind === "unit" ? "/api/prediction-units" : "/api/prediction-jobs",
              { id: job.id },
            );
            if (typeof result.ok !== "boolean" || (result.jobId || result.job?.id) !== job.id)
              throw failure("OUTBOX_RESULT_IDENTITY_MISMATCH");
            results.push({
              id: job.id,
              ok: result.ok,
              status: result.status,
              code: result.code || null,
            });
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, page.jobs.length) }, consume));
        examined += page.jobs.length;
        after = page.nextCursor;
        if (!after || examined >= maxTasksPerLane) break;
      }
      lanes[kind] = {
        examined,
        ready: results.filter((row) => row.ok && row.status === "ready").length,
        pending: results.filter((row) => row.ok && ["queued", "running"].includes(row.status))
          .length,
        failures: results.filter((row) => !row.ok),
        nextCursor: after,
      };
    }
    return { status: "checked", namespace, lanes };
  } finally {
    if (!controller.signal.aborted) controller.abort(failure("OUTBOX_DRIVER_CLOSED"));
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
