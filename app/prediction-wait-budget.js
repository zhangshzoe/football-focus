const failure = (code) => Object.assign(new Error(code), { code });

// One caller budget covers preparation, durable enqueue and subsequent reads.
// Cancellation stops waiting, not a persisted task; guard prevents late I/O
// from advancing the caller into another stage after it has already timed out.
export async function withinPredictionWaitBudget({ deadlineMs, signal }, operation) {
  if (!Number.isFinite(deadlineMs) || typeof operation !== "function")
    throw failure("INVALID_PREDICTION_WAITER");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason || failure("PREDICTION_WAIT_ABORTED"));
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(failure("PREDICTION_WAIT_TIMEOUT")),
    Math.max(0, Math.min(deadlineMs - Date.now(), 2147483647)),
  );
  const guard = () => {
    controller.signal.throwIfAborted();
    if (Date.now() >= deadlineMs) throw failure("PREDICTION_WAIT_TIMEOUT");
  };
  try {
    const result = await new Promise((resolve, reject) => {
      const cancel = () => {
        controller.signal.removeEventListener("abort", cancel);
        reject(controller.signal.reason);
      };
      controller.signal.addEventListener("abort", cancel, { once: true });
      Promise.resolve()
        .then(() => {
          guard();
          return operation({ guard, signal: controller.signal, deadlineMs });
        })
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener("abort", cancel));
      if (controller.signal.aborted) cancel();
    });
    guard();
    return result;
  } finally {
    if (!controller.signal.aborted) controller.abort(failure("PREDICTION_CALLER_FINISHED"));
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
