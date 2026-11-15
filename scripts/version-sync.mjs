#!/usr/bin/env node
/**
 * 单一版本来源：`app/package.json` 的 `version` 是唯一可手改的地方。
 * 本脚本在构建前把版本注入 `app/src-tauri/tauri.conf.json`、`app/src-tauri/Cargo.toml`
 * 与 `app/package-lock.json`，构建产物因此与 tag 同源。
 *
 * MSI 限制：WiX 只接受数字型预发布标识（`1.0.0.1` 可以，`1.0.0-alpha1` 不行），
 * 因此预发布版本会额外写入 `bundle.windows.wix.version = <major>.<minor>.<patch>.<序号>`；
 * 正式版则移除该键，由 Tauri 从应用版本推导。
 *
 * 用法：node scripts/version-sync.mjs [--check]
 *   --check  只校验不写入（CI 可用），不一致时退出码 1。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseVersion } from "./version-rules.mjs";

const root = process.cwd();
const PKG = join(root, "app", "package.json");
const LOCK = join(root, "app", "package-lock.json");
const TAURI_CONF = join(root, "app", "src-tauri", "tauri.conf.json");
const CARGO = join(root, "app", "src-tauri", "Cargo.toml");
const checkOnly = process.argv.includes("--check");

function fail(message) {
  console.error(`[version-sync] ${message}`);
  process.exit(1);
}
function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

const version = JSON.parse(readFileSync(PKG, "utf8")).version;
const parsed = parseVersion(version);
if (!parsed.ok) fail(`app/package.json 版本不合法：${parsed.reason}`);

/** 预发布 → 1.0.0.1；正式版 → null（删除该键，交给 Tauri 推导）。 */
const wixVersion = parsed.isPrerelease ? `${parsed.base}.${parsed.prerelease.number}` : null;

const cargoText = readFileSync(CARGO, "utf8");
const cargoVersion = (/^version\s*=\s*"([^"]+)"/m.exec(cargoText) || [])[1];
const config = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
const seenWix = config.bundle?.windows?.wix?.version ?? null;

const drift = [];
if (cargoVersion !== version) drift.push(`Cargo.toml=${cargoVersion}`);
if (config.version !== version) drift.push(`tauri.conf.json=${config.version}`);
if (seenWix !== wixVersion) drift.push(`tauri.conf.json wix.version=${seenWix}（期望 ${wixVersion}）`);

if (drift.length > 0 && checkOnly) {
  fail(`版本文件不一致（源 app/package.json=${version}；${drift.join("，")}）。请执行 npm run version:sync`);
}

if (drift.length > 0) {
  config.version = version;
  if (wixVersion) {
    config.bundle = config.bundle || {};
    config.bundle.windows = config.bundle.windows || {};
    config.bundle.windows.wix = { ...(config.bundle.windows.wix || {}), version: wixVersion };
  } else if (config.bundle?.windows?.wix) {
    delete config.bundle.windows.wix.version;
  }
  writeJson(TAURI_CONF, config);
  writeFileSync(CARGO, cargoText.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`), "utf8");
  if (existsSync(LOCK)) {
    const lock = JSON.parse(readFileSync(LOCK, "utf8"));
    lock.version = version;
    if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
    writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n", "utf8");
  }
  console.log(`[version-sync] 已注入 ${version} → tauri.conf.json / Cargo.toml / package-lock.json${wixVersion ? `（MSI 版本 ${wixVersion}）` : ""}`);
} else {
  console.log(`[version-sync] 版本文件已一致：${version}${checkOnly ? "（check 模式，仅校验）" : ""}`);
}
