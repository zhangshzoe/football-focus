import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { predictionBuildIdentity } from "../scripts/prediction-build-identity.mjs";

test("trusted build identity covers real computation, preparation contracts, signatures and dependencies", async () => {
  const identity = await predictionBuildIdentity();
  for (const path of [
    "app/prediction-computation.js",
    "app/prediction-unit-runtime.js",
    "app/prediction-version.ts",
    "app/team-identity.js",
    "app/sporttery-official.ts",
    "app/server-official-evidence.js",
    "app/team-history.js",
    "app/api/prediction-units/route.ts",
    "app/prediction-unit-binding.ts",
    "app/prediction-job-store.js",
    "app/prediction-model.js",
    "app/team-strength-model.js",
    "vite.config.ts",
    "package-lock.json",
    "drizzle/0004_gray_omega_sentinel.sql",
    "drizzle/meta/0004_snapshot.json",
    "drizzle/meta/_journal.json",
  ]) {
    const source = (await readFile(path, "utf8")).replace(/\r\n/g, "\n");
    assert.equal(identity.files[path], createHash("sha256").update(source).digest("hex"));
  }
  assert.equal(
    identity.sourceHash,
    createHash("sha256").update(JSON.stringify(identity.files)).digest("hex"),
  );
  assert.equal(
    Object.keys(identity.files).some((path) => path.startsWith("data/capture-attempts/")),
    false,
  );
});

test("actual changed executable bytes invalidate identity; equivalent Windows newlines do not", async () => {
  const directory = await mkdtemp(join(tmpdir(), "football-build-identity-"));
  try {
    for (const name of ["app", "worker", "scripts", "db", "drizzle", ".openai"])
      await mkdir(join(directory, name));
    for (const name of [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      ".openai/hosting.json",
    ])
      await writeFile(join(directory, name), "{}\n");
    await writeFile(join(directory, "vite.config.ts"), "export default {};\n");
    const path = join(directory, "app/numerical.js");
    await writeFile(path, "export const numerical = 1;\n");
    const first = await predictionBuildIdentity(directory);
    await writeFile(path, "export const numerical = 1;\r\n");
    assert.deepEqual(await predictionBuildIdentity(directory), first);
    await writeFile(path, "export const numerical = 2;\n");
    assert.notEqual((await predictionBuildIdentity(directory)).sourceHash, first.sourceHash);
  } finally {
    const target = resolve(directory),
      child = relative(resolve(tmpdir()), target);
    if (
      !child ||
      child.startsWith("..") ||
      child.includes("/") ||
      child.includes("\\") ||
      !child.startsWith("football-build-identity-")
    )
      throw new Error("Unsafe temporary cleanup target");
    await rm(target, { recursive: true, force: true });
  }
});
