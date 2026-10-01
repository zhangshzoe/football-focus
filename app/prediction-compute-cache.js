import { assessPredictionInput } from "./prediction-input.js";
import { PREDICTION_PIPELINE_VERSION, predictFromSnapshot } from "./prediction-model.js";

// Full canonical strings are Map keys: unlike a short hash, they cannot collide.
function canonical(value) {
  if (value === undefined) return ["undefined"];
  if (typeof value === "number" && !Number.isFinite(value)) return ["number", String(value)];
  if (Object.is(value, -0)) return ["number", "-0"];
  if (Array.isArray(value)) return ["array", value.map(canonical)];
  if (value && typeof value === "object") {
    return [
      "object",
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    ];
  }
  return [typeof value, value];
}

function withoutReadTimes({ fetchedAt, upstreamUpdatedAt, updatedAt, ...value }) {
  return value;
}

/**
 * Process-local memoization of the unchanged pure model, not a durable job queue.
 * Reports, signatures, input snapshots and continuous-time team estimates are
 * never cached. Current source-time gates are checked even for a cache hit.
 */
export function createPredictionComputeCache({
  compute = predictFromSnapshot,
  clock = Date.now,
  maxEntries = 128,
  ttlMs = 300000,
} = {}) {
  if (
    typeof compute !== "function" ||
    !Number.isInteger(maxEntries) ||
    maxEntries < 1 ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0
  )
    throw new Error("Invalid model cache options");
  const entries = new Map();
  const implementation = compute.toString();
  let hits = 0,
    misses = 0;

  /**
   * @param {object} input
   * @param {object} [parameters]
   * @param {{mode?: "official" | "research", scope?: string, calibrationId?: string}} [options]
   */
  function predict(input, parameters = {}, options = {}) {
    const { mode, scope = "", calibrationId = "cal-none" } = options;
    if (
      !["official", "research"].includes(mode) ||
      input?.schemaVersion !== 1 ||
      input.pipelineVersion !== PREDICTION_PIPELINE_VERSION
    ) {
      throw new Error("Unsupported model cache input or mode");
    }
    const quality = assessPredictionInput(input.companies || [], input.decisionAt);
    if (quality.status !== "ready") throw new Error(quality.reasons.join("；"));
    const observedAt = Date.parse(input.official?.fetchedAt),
      decisionAt = Date.parse(input.decisionAt);
    const officialFresh =
      Number.isFinite(observedAt) && observedAt <= decisionAt && decisionAt - observedAt <= 300000;
    if (mode === "official" && !officialFresh) {
      throw new Error("服务器官方赔率在模型计算前已过期或读取时刻无效，未生成正式预测。");
    }
    const key = JSON.stringify(
      canonical({
        cacheSchema: 1,
        implementation,
        mode,
        scope,
        calibrationId,
        input: {
          schemaVersion: input.schemaVersion,
          pipelineVersion: input.pipelineVersion,
          companies: input.companies.map(withoutReadTimes),
          official: withoutReadTimes(input.official || {}),
          officialFresh,
        },
        parameters,
      }),
    );
    const now = clock();
    if (!Number.isFinite(now)) throw new Error("Invalid model cache clock");
    // Expiration never slides forward on a read; source freshness is independent.
    for (const [cachedKey, row] of entries) if (row.expiresAt <= now) entries.delete(cachedKey);
    const cached = entries.get(key);
    if (cached) {
      entries.delete(key);
      entries.set(key, cached);
      hits += 1;
      return structuredClone(cached.value);
    }
    misses += 1;
    const result = compute(input, parameters);
    if (result && typeof result.then === "function")
      throw new Error("Model cache requires a synchronous pure model");
    const value = structuredClone(result);
    entries.set(key, { value, expiresAt: now + ttlMs });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return structuredClone(value);
  }
  return {
    predict,
    stats: () => ({ hits, misses, entries: entries.size }),
    clear: () => entries.clear(),
  };
}
