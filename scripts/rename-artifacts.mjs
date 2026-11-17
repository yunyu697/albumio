#!/usr/bin/env node
/**
 * 把发版产物文件名改回小写前缀 `albumio_*`。
 *
 * 背景：Tauri 的 `productName` 同时决定「系统显示名」和「产物文件名」，没有独立显示名字段。
 * 产品显示名要 `Albumio`（首字母大写），但用户下载名 / latest.json 里的资产名 / SHA256SUMS
 * 必须保持 `albumio_*` 不变，所以在打完包、展平目录之后统一把 `Albumio` 前缀改回 `albumio`。
 *
 * 必须在 `signer sign` 与 `release-manifest.mjs` 之前执行：
 * - `.sig` 是按文件名派生的，先改名再签名才不会出现 sig 名对不上；
 * - latest.json 的 url 直接取实际文件名。
 *
 * 用法：
 *   node scripts/rename-artifacts.mjs --flat dist-flat
 */
import { existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flatIndex = args.indexOf("--flat");
const flatDir = flatIndex >= 0 ? args[flatIndex + 1] : "dist-flat";

if (!existsSync(flatDir)) {
  console.error(`[rename] 目录不存在：${flatDir}`);
  process.exit(1);
}

const FROM = "Albumio";
const TO = "albumio";
const entries = readdirSync(flatDir);
// 用目录里的真实文件名判重，而不是 existsSync 探测：Windows / macOS 默认不区分大小写，
// `existsSync("albumio_x.exe")` 在只有 `Albumio_x.exe` 时也会为真，会把自己判成冲突。
const existing = new Set(entries);
let renamed = 0;

for (const name of entries) {
  const path = join(flatDir, name);
  if (!statSync(path).isFile() || !name.startsWith(FROM)) continue;
  const targetName = TO + name.slice(FROM.length);
  if (existing.has(targetName)) {
    console.error(`[rename] 目标已存在，拒绝覆盖：${join(flatDir, targetName)}`);
    process.exit(1);
  }
  // 仅大小写不同的改名在不区分大小写的文件系统上可能被当成同名，先迁到临时名再落到目标名。
  const tmp = join(flatDir, `${targetName}.casefix-tmp`);
  renameSync(path, tmp);
  renameSync(tmp, join(flatDir, targetName));
  console.log(`[rename] ${name} -> ${targetName}`);
  renamed += 1;
}

console.log(`[rename] 完成，改名 ${renamed} 个文件`);
