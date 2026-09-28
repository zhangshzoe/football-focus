import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { summarizeTotalGoals } from "../app/total-goals-evaluation.js";

// Read-only audit. Does not regenerate, rewrite, promote or publish historical snapshots.
const directory = join(process.cwd(), "data", "prediction-snapshots");
const index = JSON.parse(
  await readFile(join(process.cwd(), "data", "generated-prediction-snapshot-index.json"), "utf8"),
);
const results = new Map();
for (const row of Object.values(index.resultCache || {})) {
  const id = row.officialMatchId || row.matchId,
    date = String(row.salesDate || row.date || row.matchDate || "").slice(0, 10);
  if (id && date && row.status === "settled") results.set(`${id}|${date}`, row);
}
const records = [];
for (const name of (await readdir(directory)).filter((name) =>
  /^\d{4}-\d{2}-\d{2}_\d{4}\.raw\.json$/.test(name),
)) {
  const snapshot = JSON.parse(await readFile(join(directory, name), "utf8"));
  for (const report of snapshot.reports || []) {
    const official = report.modelInput?.official,
      result = results.get(`${official?.officialMatchId}|${official?.salesDate}`),
      score = /^(\d+):(\d+)$/.exec(String(result?.fullScore || ""));
    records.push({
      snapshotId: snapshot.snapshotId,
      capturedAt: snapshot.capturedAt,
      modelInput: report.modelInput,
      modelParameters: report.modelParameters,
      actualTotalGoals: score ? Number(score[1]) + Number(score[2]) : null,
    });
  }
}
const { rows, ...summary } = summarizeTotalGoals(records);
console.log(
  JSON.stringify(
    {
      ...summary,
      readOnly: true,
      note: "仅比较有同版本原始输入、赛前完整官方八项赔率和已核验赛果的比赛；不代表模型已提升或允许晋级。",
    },
    null,
    2,
  ),
);
