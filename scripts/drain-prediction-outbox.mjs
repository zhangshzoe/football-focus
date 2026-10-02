import { drainPredictionOutbox } from "./prediction-outbox-client.mjs";

// Secrets are supplied by the trusted runtime, never CLI arguments or files.
// This command consumes already-persisted work; it does not submit fixtures,
// fabricate source data, create snapshots or mark a cloud schedule enabled.
try {
  const result = await drainPredictionOutbox({
    origin: process.env.PREDICTION_SITE_ORIGIN,
    token: process.env.RESEARCH_CAPTURE_TOKEN,
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ status: "failed", code: error.code || "OUTBOX_DRIVER_FAILED" }));
  process.exitCode = 1;
}
