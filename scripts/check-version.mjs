#!/usr/bin/env node
/**
 * 版本校验（CI 与发布闸门都跑）：
 *   1. 版本文件一致：app/package.json / tauri.conf.json / Cargo.toml；
 *   2. 段位规则：minor 与 patch ≤ 10（11 及以上直接失败），alpha / RC 序号不受限；
 *   3. tag 必须等于 v<version>（--tag）；
 *   4. latest.json 与版本一致、三平台键齐全（--manifest）。
 *
 * 用法：
 *   node scripts/check-version.mjs
 *   node scripts/check-version.mjs --tag v1.0.0-alpha1
 *   node scripts/check-version.mjs --tag v1.0.0-alpha1 --manifest dist-flat/latest.json
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseVersion, checkTag, checkManifest } from "./version-rules.mjs";

const root = process.cwd();
const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const tagArg = argOf("--tag") || (process.env.GITHUB_REF_NAME?.startsWith("v") ? process.env.GITHUB_REF_NAME : undefined);
const manifestArg = argOf("--manifest");

const failures = [];
const notes = [];

const pkgPath = join(root, "app", "package.json");
const version = JSON.parse(readFileSync(pkgPath, "utf8")).version;
const parsed = parseVersion(version);
if (!parsed.ok) failures.push(`app/package.json 版本不合法：${parsed.reason}`);

// 1) 版本文件一致
const tauriConfig = JSON.parse(readFileSync(join(root, "app", "src-tauri", "tauri.conf.json"), "utf8"));
const cargoText = readFileSync(join(root, "app", "src-tauri", "Cargo.toml"), "utf8");
const cargoVersion = (/^version\s*=\s*"([^"]+)"/m.exec(cargoText) || [])[1];
for (const [file, seen] of [["tauri.conf.json", tauriConfig.version], ["Cargo.toml", cargoVersion]]) {
  if (seen !== version) failures.push(`版本文件不一致：${file}=${seen}，app/package.json=${version}`);
}

// 1.1) MSI 版本：WiX 只接受数字型预发布标识（1.0.0.1 可以，1.0.0-alpha1 不行）
const wixVersion = tauriConfig.bundle?.windows?.wix?.version ?? null;
if (parsed.ok && parsed.isPrerelease) {
  const expectedWix = `${parsed.base}.${parsed.prerelease.number}`;
  if (wixVersion !== expectedWix) {
    failures.push(`MSI 版本不一致：wix.version=${wixVersion}，期望 ${expectedWix}（预发布需用数字序号）`);
  }
} else if (wixVersion) {
  failures.push(`正式版不应固定 wix.version（当前 ${wixVersion}）`);
}

// 2) tag 与版本一致
if (tagArg) {
  const tagCheck = checkTag(parsed, tagArg);
  if (!tagCheck.ok) failures.push(tagCheck.reason);
  else notes.push(`tag 与版本一致：${tagArg}`);
}

// 3) latest.json 与版本一致
if (manifestArg) {
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestArg, "utf8"));
  } catch (error) {
    failures.push(`无法读取 latest.json：${manifestArg}（${error.message}）`);
  }
  if (manifest) {
    const manifestCheck = checkManifest(parsed, manifest);
    if (!manifestCheck.ok) failures.push(manifestCheck.reason);
    else notes.push(`latest.json 三平台齐全且与 ${parsed.value} 一致`);
  }
}

const summary = {
  version,
  tag: tagArg ?? null,
  prerelease: parsed.ok ? parsed.prerelease : null,
  failures,
  notes,
};
console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) {
  console.error(`[check-version] 失败：\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.error("[check-version] 通过");
