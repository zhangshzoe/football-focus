import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const root = join(process.cwd(), "data");
const groups = new Map();
let totalBytes = 0;
let totalFiles = 0;

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await inspect(path);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = (await stat(path)).size;
    const key = relative(root, path).split(/[\\/]/)[0];
    const previous = groups.get(key) ?? { files: 0, bytes: 0 };
    groups.set(key, { files: previous.files + 1, bytes: previous.bytes + bytes });
    totalBytes += bytes;
    totalFiles += 1;
  }
}

await inspect(root);
const mib = (bytes) => (bytes / 1024 / 1024).toFixed(2);
console.log(`data/: ${totalFiles} files, ${mib(totalBytes)} MiB`);
for (const [name, group] of [...groups].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${name}: ${group.files} files, ${mib(group.bytes)} MiB`);
}
const index = groups.get("generated-prediction-snapshot-index.json")?.bytes ?? 0;
if (index > 8 * 1024 * 1024 || totalBytes > 100 * 1024 * 1024) {
  console.warn("数据体积已达到迁移评估阈值；在 R2/索引替代方案上线前，不要删除 Git 历史快照。");
}
