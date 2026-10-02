import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const roots = ["app", "worker", "scripts", "db", "drizzle"];
const configFiles = [
  "package.json",
  "package-lock.json",
  "vite.config.ts",
  "tsconfig.json",
  ".openai/hosting.json",
];

async function sources(root, directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = `${directory}/${entry.name}`;
        return entry.isDirectory()
          ? sources(root, path)
          : /\.(?:[cm]?js|tsx?|sql)$/.test(entry.name) ||
              (directory.startsWith("drizzle/") && entry.name.endsWith(".json"))
            ? [path]
            : [];
      }),
    )
  ).flat();
}

// Inputs and selected calibration/history live in each prepared object's full
// hash. This independent identity covers actual executable glue and dependencies,
// without changing the already frozen ten-file forward experiment manifest.
export async function predictionBuildIdentity(root = process.cwd()) {
  const paths = [
    ...configFiles,
    ...(await Promise.all(roots.map((directory) => sources(root, directory)))).flat(),
  ].sort();
  const files = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        digest((await readFile(join(root, path), "utf8")).replace(/\r\n/g, "\n")),
      ]),
    ),
  );
  return { schemaVersion: 1, sourceHash: digest(JSON.stringify(files)), files };
}
