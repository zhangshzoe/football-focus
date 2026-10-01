import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTotalGoalsValidation, projectTotalGoalRawSnapshot, projectTotalGoalPurchase } from "../app/total-goals-validation.js";
import { readLocalCaptureReceipt } from "./local-capture-receipts.mjs";

export async function syncTotalGoalsValidation({ root = process.cwd(), tracked, today, resultEvents, fixtureUniverse, sourceAttempts }) {
  const observations = [], purchases = [];
  for (const directory of ["prediction-snapshots", "purchase-plan-snapshots"]) {
    for (const name of (await readdir(join(root, "data", directory))).sort()) {
      if (!(directory === "prediction-snapshots" ? /^\d{4}-\d{2}-\d{2}_\d{4}\.raw\.json$/ : /^\d{4}-\d{2}-\d{2}_.*\.json$/).test(name)) continue;
      if (!tracked.has(`data/${directory}/${name}`) && !name.startsWith(`${today}_`)) continue;
      const raw = JSON.parse(await readFile(join(root, "data", directory, name), "utf8"));
      const receipt = await readLocalCaptureReceipt(raw, root);
      observations.push(...projectTotalGoalRawSnapshot(raw, receipt));
      if (raw.recordType === "purchase-plan-snapshot") purchases.push(projectTotalGoalPurchase(raw, receipt));
    }
  }
  const report = buildTotalGoalsValidation({ observations, purchases, resultEvents, fixtureUniverse, sourceAttempts });
  // Inputs support future cloud background replay. Page GET returns only report.
  const body = { schemaVersion: 1, observations, purchases, report };
  const path = join(root, "data", "generated-total-goals-validation-index.json");
  const previous = JSON.parse(await readFile(path, "utf8").catch((e) => { if (e.code === "ENOENT") return "null"; throw e; }));
  const content = (value) => JSON.stringify({ ...value, report: { ...value.report, evaluatedAt: undefined } });
  if (previous && content(previous) === content(body)) return { status: "unchanged", sampleSize: previous.report.comparableMatches };
  await writeFile(path, `${JSON.stringify(body)}\n`, "utf8");
  return { status: "saved", sampleSize: report.comparableMatches, attemptedRecords: report.attemptedRecords };
}
