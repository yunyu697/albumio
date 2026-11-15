#!/usr/bin/env node
/**
 * 图标一形一义校验（02-设计规范 §5.3）。
 *
 * 扫描 `design/index.html` 与 `app/src/App.tsx` 里的交互控件（button / label），
 * 收集「图标 id → 出现处的动作文案」，与 `design/icon-registry.json` 对照：
 *   - 同一图形重复（几何完全相同）→ 失败；
 *   - 图形出现在未登记的动作文案上（即一形多义）→ 失败；
 *   - 控件用了设计稿里不存在的图形，或实现缺图形 → 失败；
 *   - 登记了但设计稿/实现里都找不到 → 失败（防止登记表腐烂）。
 *
 * 用法：node scripts/check-icons.mjs [--dump]
 *   --dump 打印扫描到的「图形 → 文案」清单，便于维护登记表。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const DESIGN = join(root, "design", "index.html");
const APP = join(root, "app", "src", "App.tsx");
const ICONS = join(root, "app", "src", "icons.tsx");
const REGISTRY = join(root, "design", "icon-registry.json");

const designHtml = readFileSync(DESIGN, "utf8");
const appTsx = readFileSync(APP, "utf8");
const iconsTsx = readFileSync(ICONS, "utf8");
const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));

const NORMALIZE_TAG = /<[^>]+>/g;

/** 文案归一：去掉快捷键括注与标签，压平空白。 */
function normalizeLabel(raw) {
  return raw
    .replace(/\$\{[^}]*\}/g, " ")
    .replace(/<kbd>[\s\S]*?<\/kbd>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(html) {
  return html.replace(NORMALIZE_TAG, " ").replace(/\s+/g, " ").trim();
}

// —— 1. 设计稿 <symbol>：id 与几何 ——
const symbols = new Map();
for (const m of designHtml.matchAll(/<symbol id="(i-[a-z0-9-]+)"[^>]*>([\s\S]*?)<\/symbol>/g)) {
  symbols.set(m[1], m[2].replace(/\s+/g, ""));
}

// —— 2. 实现 icons.tsx：id 集合（几何逐字对齐设计稿，见文件头注释）——
const appIconIds = new Set();
for (const m of iconsTsx.matchAll(/"?(i-[a-z0-9-]+)"?\s*:/g)) appIconIds.add(m[1]);

// —— 3. 扫描交互控件：button / label ——
function collectUsages(html, mode) {
  const found = [];
  const blockRe = /<(button|label)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const block of html.matchAll(blockRe)) {
    const [, , attrs, inner] = block;
    const ids = mode === "design"
      ? [...inner.matchAll(/<use href="#(i-[a-z0-9-]+)"\/?>/g)].map((m) => m[1])
      : [...inner.matchAll(/<Icon\s+id="(i-[a-z0-9-]+)"/g)].map((m) => m[1]);
    if (ids.length === 0) continue;
    const title = /title="([^"]*)"/.exec(attrs)?.[1];
    const tip = /<span\s+class(?:Name)?="tip[^"]*">([\s\S]*?)<\/span>/i.exec(inner)?.[1];
    const visible = stripTags(inner.replace(/<svg[\s\S]*?<\/svg>/gi, " "));
    const aria = /aria-label="([^"]*)"/i.exec(inner)?.[1];
    const label = normalizeLabel(title || tip || visible || aria || "");
    for (const id of ids) found.push({ id, label, where: mode });
  }
  return found;
}
const usages = [...collectUsages(designHtml, "design"), ...collectUsages(appTsx, "app")];

// —— 4. 汇总「图形 → 文案集合」——
const byIcon = new Map();
const designIcons = new Set();
const appUsedIcons = new Set();
for (const u of usages) {
  if (!byIcon.has(u.id)) byIcon.set(u.id, new Set());
  byIcon.get(u.id).add(u.label);
  if (u.where === "design") designIcons.add(u.id);
  else appUsedIcons.add(u.id);
}

if (process.argv.includes("--dump")) {
  const dump = {};
  for (const [id, labels] of [...byIcon.entries()].sort()) dump[id] = [...labels].sort();
  console.log(JSON.stringify(dump, null, 2));
  process.exit(0);
}

const failures = [];
const warnings = [];

// 4.1 几何重复：同一图形不得存在两个 id
const byGeometry = new Map();
for (const [id, geometry] of symbols) {
  if (!byGeometry.has(geometry)) byGeometry.set(geometry, []);
  byGeometry.get(geometry).push(id);
}
for (const ids of byGeometry.values()) {
  if (ids.length > 1) failures.push(`图形重复：${ids.join(" 与 ")} 的几何完全相同，一个动作只能有一个图形`);
}

// 4.2 登记表对照
const registered = registry.icons || {};
for (const [id, labels] of byIcon.entries()) {
  // 设计稿只在设计稿里用到的图形必须存在；实现只校验它自己引用的图形（未实现的界面不要求）。
  if (designIcons.has(id) && !symbols.has(id)) failures.push(`设计稿缺少图形：${id}（设计稿自身引用了它）`);
  if (appUsedIcons.has(id) && !appIconIds.has(id)) failures.push(`实现 icons.tsx 缺少图形：${id}`);
  const entry = registered[id];
  if (!entry) {
    failures.push(`未登记图形：${id}（出现在动作「${[...labels].join("」「")}」；先在 design/icon-registry.json 登记）`);
    continue;
  }
  if (!entry.meaning) failures.push(`登记表 ${id} 缺少 meaning`);
  const allowed = new Set(entry.labels || []);
  for (const label of labels) {
    if (!allowed.has(label)) {
      failures.push(
        `一形多义：${id}（${entry.meaning}）出现在「${label}」上，未在登记表允许；` +
          `若这是另一个动作，请新增图形，不要复用 ${id}`,
      );
    }
  }
  for (const label of allowed) {
    if (!labels.has(label)) warnings.push(`登记表 ${id} 声明了未出现的文案「${label}」`);
  }
}

// 4.3 登记表里既不出现也没被引用的条目（腐烂）
for (const id of Object.keys(registered)) {
  if (!byIcon.has(id)) failures.push(`登记表条目 ${id} 未在交互控件中出现，请删除或补上使用处`);
}

// 4.4 实现里的图形必须在设计稿里存在（G1：设计稿是唯一来源）
for (const id of appIconIds) {
  if (!symbols.has(id)) failures.push(`实现多出设计稿没有的图形：${id}`);
}

for (const w of warnings) console.warn(`[check-icons] 提示：${w}`);
if (failures.length > 0) {
  console.error(`[check-icons] 失败 ${failures.length} 项：`);
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`[check-icons] 通过：${symbols.size} 个图形、${byIcon.size} 个交互图标、${Object.keys(registered).length} 条登记`);
