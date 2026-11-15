/**
 * S4 样本生成：在给定目录生成 1 万个空文件（不同扩展名）。
 * 只用于 docs/spike/S4.md 的复跑，不参与构建。
 *
 * 用法：node scripts/spike-s4-files.mjs <目录> [数量]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const count = Number(process.argv[3] ?? 10000);
if (!dir) {
  console.error("用法：node scripts/spike-s4-files.mjs <目录> [数量]");
  process.exit(1);
}

mkdirSync(dir, { recursive: true });
const exts = ["JPG", "JPG", "JPG", "PNG", "HEIC"];
for (let i = 0; i < count; i++) {
  const name = `DSC_${String(i).padStart(5, "0")}.${exts[i % exts.length]}`;
  writeFileSync(join(dir, name), "");
}
console.log(`已生成 ${count} 个文件：${dir}`);
