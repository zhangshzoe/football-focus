const JOB_ID = /^prediction-[a-f0-9]{64}$/;
const failure = (code) => Object.assign(new Error(code), { code });

// The waiter receives only a read capability. No consumption, signing, source
// fetching or task mutation is reachable from this polling lifecycle.
export async function waitForPredictionBatch({
  readStatus,
  jobId,
  deadlineMs,
  signal,
  pollIntervalMs = 500,
  clock = Date.now,
}) {
  if (
    typeof readStatus !== "function" ||
    !JOB_ID.test(jobId || "") ||
    !Number.isFinite(deadlineMs) ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > 5000 ||
    typeof clock !== "function"
  )
    throw failure("INVALID_PREDICTION_WAITER");
  const initialNow = clock();
  if (!Number.isFinite(initialNow)) throw failure("INVALID_PREDICTION_WAITER");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || failure("PREDICTION_WAIT_ABORTED"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const remaining = deadlineMs - initialNow;
  const timer = setTimeout(
    () => controller.abort(failure("PREDICTION_WAIT_TIMEOUT")),
    Math.max(0, Math.min(remaining, 2147483647)),
  );
  const guard = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (clock() >= deadlineMs) throw failure("PREDICTION_WAIT_TIMEOUT");
  };
  const bounded = (start) =>
    new Promise((resolve, reject) => {
      guard();
      const cancel = () => {
        controller.signal.removeEventListener("abort", cancel);
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      Promise.resolve()
        .then(() => {
          guard();
          return start();
        })
        .then(resolve, reject)
        .finally(() => {
          controller.signal.removeEventListener("abort", cancel);
        });
    });
  try {
    for (;;) {
      guard();
      const result = await bounded(() => readStatus(jobId));
      guard(); // A late R2 response cannot publish beyond this caller's deadline.
      if (!result?.ok) throw failure(result?.code || "PREDICTION_BATCH_READ_FAILED");
      if (result.jobId !== jobId) throw failure("PREDICTION_JOB_IDENTITY_MISMATCH");
      if (result.status === "ready") {
        if (
          !Array.isArray(result.reports) ||
          !result.reports.length ||
          !result.predictionId ||
          result.version?.predictionId !== result.predictionId
        )
          throw failure("PREDICTION_BATCH_RESULT_INCOMPLETE");
        return result;
      }
      if (
        !["queued", "running"].includes(result.status) ||
        Object.hasOwn(result, "reports") ||
        Object.hasOwn(result, "predictionId")
      )
        throw failure("PREDICTION_BATCH_STATUS_INVALID");
      await bounded(
        () =>
          new Promise((resolve) => {
            const cancel = () => {
              clearTimeout(timeout);
              controller.signal.removeEventListener("abort", cancel);
              resolve();
            };
            const timeout = setTimeout(
              () => {
                controller.signal.removeEventListener("abort", cancel);
                resolve();
              },
              Math.min(pollIntervalMs, deadlineMs - clock()),
            );
            controller.signal.addEventListener("abort", cancel, { once: true });
          }),
      );
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
