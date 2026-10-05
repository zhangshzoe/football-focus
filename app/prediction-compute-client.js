// HTTP lifecycle only. This module never performs or simulates model work.
// Consumers run in separate requests; manual mode requires explicit operator POSTs.
export class PredictionRequestError extends Error {
  /** @param {string} message @param {{code?: string, status?: number, sourceState?: unknown}} [options] */
  constructor(message, { code = "PREDICTION_RESPONSE_INVALID", status, sourceState } = {}) {
    super(message);
    this.name = "PredictionRequestError";
    this.code = code;
    this.status = status;
    this.sourceState = sourceState;
  }
}

const abortError = () => new DOMException("预测读取已取消", "AbortError");
const timeoutError = () =>
  new PredictionRequestError("预测尚未在等待期限内完成；未把排队任务计为零场或已完成快照。", {
    code: "PREDICTION_WAIT_TIMEOUT",
  });

async function readResponse(response) {
  let data;
  try {
    data = await response.json();
  } catch {
    throw new PredictionRequestError(`预测接口返回非 JSON 内容（HTTP ${response.status}）`, {
      status: response.status,
    });
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new PredictionRequestError("预测接口返回结构无效", { status: response.status });
  if (!response.ok)
    throw new PredictionRequestError(
      typeof data.error === "string" ? data.error : `预测读取失败（HTTP ${response.status}）`,
      {
        code: typeof data.code === "string" ? data.code : "PREDICTION_REQUEST_FAILED",
        status: response.status,
        sourceState: data.sourceState,
      },
    );
  return data;
}

function assertReady(response, data) {
  if (
    response.status !== 200 ||
    !Array.isArray(data.reports) ||
    (data.status !== undefined && !["ready", "complete"].includes(data.status)) ||
    (data.error !== undefined && data.error !== null && data.error !== "")
  )
    throw new PredictionRequestError(
      typeof data.error === "string" ? data.error : "预测任务尚未提供完整结果，未按空预测处理。",
      {
        code: typeof data.code === "string" ? data.code : "PREDICTION_NOT_READY",
        status: response.status,
        sourceState: data.sourceState,
      },
    );
  return data;
}

// Trusted in-process capture callers currently have no independent job reader.
// They must reject pending responses rather than certify a capture as complete.
export async function readCompletedPredictionResponse(response) {
  return assertReady(response, await readResponse(response));
}

function pendingJob(data, expectedId) {
  if (
    typeof data.jobId !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,180}$/.test(data.jobId || "") ||
    !["queued", "running"].includes(data.status) ||
    Object.hasOwn(data, "reports") ||
    Object.hasOwn(data, "predictionId") ||
    (expectedId && data.jobId !== expectedId)
  )
    throw new PredictionRequestError("预测排队响应身份或状态不一致，未采用其中的结果。");
  return { jobId: data.jobId, status: data.status };
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason || abortError());
      return;
    }
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(signal.reason || abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

// A single deadline also bounds a stalled body or a transport that fails to
// reject promptly on abort. Its late completion can never publish a result.
function withSignal(operation, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      Promise.resolve(operation).catch(() => {});
      reject(signal.reason || abortError());
      return;
    }
    const cancel = () => {
      signal.removeEventListener("abort", cancel);
      reject(signal.reason || abortError());
    };
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}

/**
 * Read the unchanged final prediction envelope, or await an explicit server job.
 * @param {{endpoint?: string, fixtureIds?: string[], forceRefresh?: boolean, research?: boolean,
 * signal?: AbortSignal, timeoutMs?: number, pollIntervalMs?: number,
 * requestHeaders?: HeadersInit, fetcher?: typeof fetch, clock?: () => number,
 * onPending?: (job: {jobId: string, status: string}) => void}} [options]
 */
export async function requestPredictionResult(options = {}) {
  const {
    endpoint = "/api/predictions",
    fixtureIds = [],
    forceRefresh = false,
    research = false,
    signal,
    timeoutMs = 120000,
    pollIntervalMs = 1000,
    requestHeaders,
    fetcher = (...args) => globalThis.fetch(...args),
    clock = Date.now,
    onPending,
  } = options;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 300000 ||
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > 10000
  )
    throw new PredictionRequestError("预测等待预算无效");
  // Do not accept protocol-relative or path-relative addresses: their initial
  // request and status request can otherwise resolve to different servers.
  if (
    typeof endpoint !== "string" ||
    !/^(?:\/api\/predictions(?:[?#]|$)|https?:\/\/)/.test(endpoint)
  )
    throw new PredictionRequestError("预测接口地址无效");
  const address = new URL(endpoint, "https://football-focus.invalid");
  if (
    !["http:", "https:"].includes(address.protocol) ||
    address.pathname !== "/api/predictions" ||
    address.username ||
    address.password
  )
    throw new PredictionRequestError("预测接口地址无效");
  const controller = new AbortController(),
    headers = new Headers(requestHeaders),
    startedAt = clock();
  if (!Number.isFinite(startedAt)) throw new PredictionRequestError("预测等待时钟无效");
  const deadline = startedAt + timeoutMs;
  let timedOut = false;
  const cancel = () => controller.abort(abortError());
  if (signal?.aborted) throw abortError();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError());
  }, timeoutMs);
  const remaining = () => {
    const now = clock();
    if (!Number.isFinite(now) || now < startedAt)
      throw new PredictionRequestError("预测等待时钟无效");
    if (timedOut || now >= deadline) throw timeoutError();
    if (controller.signal.aborted) throw controller.signal.reason || abortError();
    return deadline - now;
  };
  try {
    remaining();
    if (!research) headers.set("Content-Type", "application/json");
    let response = await withSignal(
      fetcher(endpoint, {
        method: research ? "GET" : "POST",
        headers,
        cache: "no-store",
        signal: controller.signal,
        ...(research ? {} : { body: JSON.stringify({ fixtureIds, forceRefresh }) }),
      }),
      controller.signal,
    );
    let data = await withSignal(readResponse(response), controller.signal);
    remaining();
    if (response.status !== 202) return assertReady(response, data);
    const job = pendingJob(data);
    const manual = data.executionMode === "manual";
    const executionEndpoint = `${endpoint.startsWith("/") ? "" : address.origin}/api/prediction-execution`;
    const statusEndpoint = `${endpoint.startsWith("/") ? "" : address.origin}/api/prediction-jobs?jobId=${encodeURIComponent(job.jobId)}`;
    // Never follow a caller/server supplied status URL to another origin.
    for (;;) {
      onPending?.(pendingJob(data, job.jobId));
      await wait(Math.min(pollIntervalMs, remaining()), controller.signal);
      remaining();
      response = await withSignal(
        fetcher(manual ? executionEndpoint : statusEndpoint, {
          method: manual ? "POST" : "GET",
          headers,
          cache: "no-store",
          signal: controller.signal,
          ...(manual ? { body: JSON.stringify({ id: job.jobId }) } : {}),
        }),
        controller.signal,
      );
      data = await withSignal(readResponse(response), controller.signal);
      remaining();
      if (data.jobId !== job.jobId)
        throw new PredictionRequestError("预测任务结果不属于本次请求，已拒绝覆盖。");
      if (response.status !== 202) return assertReady(response, data);
    }
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (timedOut) throw timeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
