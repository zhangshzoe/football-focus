import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  latestForwardManifest,
  researchHash,
  evaluateForwardValidation,
  mergeFirstObservedResults,
} from "../app/forward-validation.js";
import { readResearchFiles, forwardCodeHashes } from "./forward-research-files.mjs";
export async function syncForwardValidationIndex({
  fixtureUniverse = [],
  resultEvents = [],
  resultEventErrors = [],
} = {}) {
  const root = process.cwd(),
    manifests = await readResearchFiles(join(root, "data", "forward-validation-manifests")),
    records = await readResearchFiles(join(root, "data", "forward-validation-captures"));
  const manifest = latestForwardManifest(manifests);
  const receipts = new Map(
    records
      .filter((r) => r.recordType === "forward-capture-receipt" && r.immutable)
      .map((r) => [r.captureId, r]),
  );
  const captures = records
    .filter(
      (r) =>
        r.recordType === "forward-candidate-capture" &&
        r.manifestHash === manifest?.manifestHash &&
        receipts.get(r.captureId)?.contentHash === r.contentHash,
    )
    .map((r) => ({ ...r, persistedAt: receipts.get(r.captureId).persistedAt }));
  const localResults = await readResearchFiles(join(root, "data", "research-result-events"));
  const merged = mergeFirstObservedResults([...localResults, ...resultEvents], { now: Date.now() }),
    events = merged.records,
    invalidResultEvents = [...resultEventErrors, ...merged.invalid];
  const universe = [...new Map(fixtureUniverse.map((r) => [researchHash(r), r])).values()];
  const implementationHashes = await forwardCodeHashes();
  const evaluation = invalidResultEvents.length
    ? {
        status: "result-integrity-failed",
        eligible: false,
        sampleSize: 0,
        reason: "首次观测赛果校验失败",
        invalidResultEvents,
      }
    : manifest && researchHash(implementationHashes) !== researchHash(manifest.codeHashes)
      ? {
          status: "implementation-changed",
          eligible: false,
          sampleSize: 0,
          reason: "冻结后实现变化，需要新的未来版本",
        }
      : evaluateForwardValidation({
          manifest,
          captures,
          resultEvents: events,
          fixtureUniverse: universe,
        });
  const output = {
      schemaVersion: 1,
      manifest,
      captures,
      resultEvents: events,
      invalidResultEvents,
      fixtureUniverse: universe,
      implementationHashes,
      evaluation,
      evaluatedAt: new Date().toISOString(),
    },
    path = join(root, "data", "generated-forward-validation-index.json");
  const previous = JSON.parse(await readFile(path, "utf8").catch(() => "null"));
  if (
    previous &&
    researchHash({ ...previous, evaluatedAt: undefined }) ===
      researchHash({ ...output, evaluatedAt: undefined })
  )
    output.evaluatedAt = previous.evaluatedAt;
  const text = JSON.stringify(output) + "\n";
  if ((await readFile(path, "utf8").catch(() => "")) !== text) await writeFile(path, text);
  return {
    status: "indexed",
    manifestId: manifest?.manifestId || null,
    captures: captures.length,
    resultEvents: events.length,
    invalidResultEvents: invalidResultEvents.length,
  };
}
