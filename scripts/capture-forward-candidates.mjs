import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  runForwardCandidates,
  latestForwardManifest,
  verifyForwardSourceSnapshot,
} from "../app/forward-validation.js";
import { readResearchFiles, forwardCodeHashes } from "./forward-research-files.mjs";

export async function captureForwardCandidates(raw) {
  const receivedAt = new Date().toISOString();
  if (!verifyForwardSourceSnapshot(raw, receivedAt))
    return { status: "rejected", reason: "raw-snapshot-provenance-invalid", saved: 0 };
  const manifests = await readResearchFiles(
    join(process.cwd(), "data", "forward-validation-manifests"),
  );
  const manifest = latestForwardManifest(manifests);
  if (!manifest) return { status: "not-frozen", saved: 0 };
  const historyIndex = JSON.parse(
      await readFile(join(process.cwd(), "data", "generated-team-history-index.json"), "utf8"),
    ),
    codeHashes = await forwardCodeHashes(),
    records = [],
    excluded = [];
  const directory = join(process.cwd(), "data", "forward-validation-captures");
  await mkdir(directory, { recursive: true });
  for (const report of raw.reports || []) {
    try {
      const capture = runForwardCandidates({
        manifest,
        report,
        historyIndex,
        codeHashes,
        startedAt: new Date().toISOString(),
      });
      const path = join(directory, capture.captureId + ".json");
      // Persist the actual input/output first. A separate append-only receipt,
      // created after successful write, proves when this evidence existed.
      await writeFile(path, JSON.stringify(capture) + "\n", { flag: "wx" });
      const receipt = {
        recordType: "forward-capture-receipt",
        immutable: true,
        captureId: capture.captureId,
        contentHash: capture.contentHash,
        rawSnapshotId: raw.snapshotId,
        persistedAt: new Date().toISOString(),
      };
      await writeFile(
        join(directory, capture.captureId + ".receipt.json"),
        JSON.stringify(receipt) + "\n",
        { flag: "wx" },
      );
      records.push(receipt);
    } catch (error) {
      excluded.push({ officialMatchId: report.officialMatchId, reason: error.message });
    }
  }
  return { status: "captured", saved: records.length, records, excluded };
}
