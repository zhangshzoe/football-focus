// Offline policy building block only. This is NOT a cloud runner, durable claim,
// authorization check, or production activation switch. Never call a capture
// until an authenticated writer atomically claims the returned unique key in D1.
const slots = Object.freeze({
  purchase: Object.freeze({1700: "17:10", 2100: "21:10"}),
  daily: Object.freeze({1330: "13:30", 1530: "15:30", 1730: "17:30", 1930: "19:30", 2130: "21:30"}),
  results: Object.freeze({1000: "10:00"}),
});
export const CLOUD_CAPTURE_TIMEZONE = "Asia/Shanghai";
export const CLOUD_CAPTURE_WINDOW_MS = 15 * 60 * 1000;

export function cloudBatchIdentity({namespace, date, type, slot}) {
  if (namespace !== "production" && !/^test-[a-z0-9][a-z0-9-]{0,63}$/.test(namespace || "")) throw new Error("Invalid isolated namespace");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("Invalid Shanghai date");
  const midnight = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) throw new Error("Invalid Shanghai date");
  const clock = Object.hasOwn(slots, type) && Object.hasOwn(slots[type], slot) ? slots[type][slot] : null;
  if (!clock) throw new Error("Invalid task type or fixed batch slot");
  const scheduledAt = `${date}T${clock}:00+08:00`;
  return Object.freeze({namespace, date, type, slot: String(slot), key: `${namespace}|${date}|${type}|${slot}`, scheduledAt, opensAt: Date.parse(scheduledAt), closesAt: Date.parse(scheduledAt) + CLOUD_CAPTURE_WINDOW_MS});
}

// existing is a read-only durable observation, not an in-memory dedup store.
// A claim-required response is never permission to fetch: a later atomic claim
// must recheck database time, cutover ownership and this exact unique key.
export function inspectCloudBatch(identity, {now, existing = null, cutoverVerified = false} = {}) {
  const batch = cloudBatchIdentity(identity);
  if (!Number.isFinite(now)) throw new Error("A trusted current clock is required");
  if (existing) {
    if (existing.key !== batch.key) throw new Error("Durable batch identity mismatch");
    if (existing.status === "complete") return {status: "readback-required", key: batch.key};
    if (["failed", "missed"].includes(existing.status)) return {status: "terminal-no-retry", key: batch.key};
    if (existing.status === "running") return {status: "observe-only", key: batch.key};
    throw new Error("Unknown durable batch state; fail closed");
  }
  if (now < batch.opensAt) return {status: "not-due", key: batch.key};
  // End is exclusive: 17:25:00 is outside the 17:10 fifteen-minute window.
  if (now >= batch.closesAt) return {status: "missed-no-capture", key: batch.key};
  if (batch.namespace === "production" && !cutoverVerified) return {status: "cutover-blocked", key: batch.key};
  return {status: "atomic-claim-required", key: batch.key};
}
