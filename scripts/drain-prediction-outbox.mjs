import { drainPredictionOutbox } from "./prediction-outbox-client.mjs";

// Secrets are supplied by the trusted runtime, never CLI arguments or files.
// This command consumes already-persisted work; it does not submit fixtures,
// fabricate source data, create snapshots or mark a cloud schedule enabled.
try {
  const origin = process.env.PREDICTION_SITE_ORIGIN, token = process.env.RESEARCH_CAPTURE_TOKEN;
  const loop = process.argv.includes("--loop");
  // Service supervisors restart this process; no browser/request owns its lifetime.
  // A manual/service invocation must never label itself a scheduled capture.
  const trigger = loop ? "service" : "manual";
  const heartbeat = async (status) => {
    const base = new URL(origin);
    if (!token || token.length < 32 || base.username || base.password || base.pathname !== "/" ||
      (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))))
      throw new Error("Invalid driver configuration");
    const response = await fetch(new URL("/api/prediction-runtime", base), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status, trigger }),
    });
    if (!response.ok || (await response.json()).readback !== true) throw new Error("Heartbeat unavailable");
  };
  do {
    await heartbeat("running");
    try {
      const result = await drainPredictionOutbox({ origin, token, deadlineMs: Date.now() + 60000 });
      const failed = Object.values(result.lanes).some(lane => lane.failures.length);
      await heartbeat(failed ? "failed" : "checked");
      console.log(JSON.stringify(result));
    } catch (error) {
      await heartbeat("failed").catch(() => {});
      throw error;
    }
    if (loop) await new Promise(resolve => setTimeout(resolve, 5000));
  } while (loop);
} catch (error) {
  console.error(JSON.stringify({ status: "failed", code: error.code || "OUTBOX_DRIVER_FAILED" }));
  process.exitCode = 1;
}
