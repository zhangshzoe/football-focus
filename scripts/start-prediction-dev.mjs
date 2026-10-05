import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localPredictionDatabase } from "./local-prediction-bindings.mjs";

// Local-only supervisor. Migration precedes HTTP startup; the consumer has an
// independent process lifetime and never depends on a submitting browser.
const root = fileURLToPath(new URL("../", import.meta.url));
const children = new Set();
let stopping = false;
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false",
  RESEARCH_CAPTURE_TOKEN: process.env.RESEARCH_CAPTURE_TOKEN || randomBytes(32).toString("hex") };
function launch(args) {
  const child = spawn(process.execPath, args, { cwd: root, env, windowsHide: true, stdio: "inherit" });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
function finished(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Child exited (${code})`)));
  });
}
function stop(code = 0) {
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
try {
  const directory = path.join(root, ".sites-runtime");
  await mkdir(directory, { recursive: true });
  const config = path.join(directory, "local-prediction-wrangler.json");
  // Generated local configuration contains NO secret and cannot address remote D1.
  await writeFile(config, JSON.stringify({ name: "football-focus-local", compatibility_date: "2026-07-01",
    d1_databases: [{ ...localPredictionDatabase, migrations_dir: path.join(root, "drizzle") }] }));
  await finished(launch(["node_modules/wrangler/bin/wrangler.js", "d1", "migrations", "apply", "DB",
    "--local", "--config", config, "--persist-to", path.join(root, ".wrangler/state")]));
  if (stopping) process.exit();
  const args = process.argv.slice(2);
  const portArgument = args.find((arg) => arg.startsWith("--port="));
  const port = portArgument?.split("=")[1] || (args.includes("--port") ? args[args.indexOf("--port") + 1] : "3000");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid port");
  env.PREDICTION_SITE_ORIGIN = `http://127.0.0.1:${port}`;
  const hostArgs = args.some((arg) => arg === "--hostname" || arg === "-H" || arg.startsWith("--hostname=")) ? [] : ["--hostname", "127.0.0.1"];
  const server = launch(["node_modules/vinext/dist/cli.js", "dev", ...args, ...hostArgs]);
  server.once("exit", (code) => stop(code || 0));
  // A bounded readiness wait does not run inference or write a fake heartbeat.
  let ready = false, readinessReason = "not-checked";
  for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
    try {
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const response = await fetch(`${env.PREDICTION_SITE_ORIGIN}/api/prediction-versions?salesDate=${date}`, {
        signal: AbortSignal.timeout(2000), redirect: "error",
      });
      const body = await response.json();
      if (response.ok && typeof body.status === "string") { ready = true; break; }
      readinessReason = `HTTP ${response.status}`;
    } catch (error) { readinessReason = error.cause?.code || error.name; }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error(`Local prediction database/server readiness failed (${readinessReason})`);
  // Bounded process recovery. An unhealthy consumer expires its real heartbeat;
  // this supervisor never manufactures one or labels a manual run as scheduled.
  for (let restarts = 0; !stopping && restarts < 4; restarts++) {
    try { await finished(launch(["scripts/drain-prediction-outbox.mjs", "--loop"])); }
    catch { if (!stopping) console.error("Local prediction consumer stopped; retrying with backoff."); }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, Math.min(30000, 2000 * 2 ** restarts)));
  }
  if (!stopping) console.error("Local prediction consumer unavailable after bounded retries. Restart after resolving the reported failure.");
} catch (error) {
  console.error(`Local prediction startup failed: ${error.message}`);
  stop(1);
}
