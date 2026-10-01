import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cloudCaptureReceipt, verifyCloudCaptureReceipt } from "../app/cloud-capture-receipt.js";
import { researchHash } from "../app/forward-validation.js";

const pathFor = (root, id) => join(root, "data", "capture-receipts", `${researchHash(id)}.json`);
export async function readLocalCaptureReceipt(raw, root = process.cwd()) {
  try { return verifyCloudCaptureReceipt(raw, JSON.parse(await readFile(pathFor(root, raw.snapshotId), "utf8"))); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Called immediately after a NEW create-only raw write and full readback.
// Missing old receipts stay missing; this is deliberately not a recovery job.
export async function appendLocalCaptureReceipt(raw, rawPath, root = process.cwd(), clock = () => new Date().toISOString()) {
  const readback = JSON.parse(await readFile(rawPath, "utf8"));
  if (researchHash(readback) !== researchHash(raw)) throw new Error("本地原始快照回读哈希不一致");
  await mkdir(join(root, "data", "capture-receipts"), { recursive: true });
  const receipt = cloudCaptureReceipt(raw, clock(), { recovered: false });
  await writeFile(pathFor(root, raw.snapshotId), `${JSON.stringify(receipt)}\n`, { encoding: "utf8", flag: "wx" });
  return readLocalCaptureReceipt(raw, root);
}
