#!/usr/bin/env node
/**
 * 版本规则自测：证明校验能拦住不合规版本、进位符合规则，并确认仓库当前版本合规。
 * 用法：node scripts/version-rules-test.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseVersion, bumpVersion, checkTag, checkManifest } from "./version-rules.mjs";

let passed = 0;
const failures = [];

function expectReject(label, result) {
  if (result.ok) failures.push(`${label}：本应失败，却通过了`);
  else passed += 1;
}
function expectAccept(label, result) {
  if (!result.ok) failures.push(`${label}：本应通过，却失败了（${result.reason}）`);
  else passed += 1;
}
function expectEqual(label, actual, expected) {
  if (actual === expected) passed += 1;
  else failures.push(`${label}：期望 ${expected}，实际 ${actual}`);
}

// 1) 三段位格式与预发布后缀
expectAccept("1.0.0", parseVersion("1.0.0"));
expectAccept("1.0.0-alpha1", parseVersion("1.0.0-alpha1"));
expectAccept("1.0.0-RC1", parseVersion("1.0.0-RC1"));
expectReject("缺 patch：1.0", parseVersion("1.0"));
expectReject("小写 rc：1.0.0-rc1", parseVersion("1.0.0-rc1"));
expectReject("alpha 与 RC 并存", parseVersion("1.0.0-alpha1-RC1"));

// 2) 段位上限：minor / patch 出现 11 及以上即失败；10 是合法边界
expectReject("1.11.0（minor=11）", parseVersion("1.11.0"));
expectReject("1.0.11（patch=11）", parseVersion("1.0.11"));
expectReject("1.10.11（patch=11）", parseVersion("1.10.11"));
expectAccept("1.10.10（边界 10）", parseVersion("1.10.10"));
expectAccept("1.0.10（边界 10）", parseVersion("1.0.10"));
expectAccept("11.10.10（首段不限）", parseVersion("11.10.10"));

// 3) alpha / RC 序号不受上限约束
expectAccept("alpha123", parseVersion("1.0.0-alpha123"));
expectAccept("RC2026", parseVersion("1.0.0-RC2026"));
expectReject("alpha0", parseVersion("1.0.0-alpha0"));
expectReject("alpha01（前导零）", parseVersion("1.0.0-alpha01"));
expectReject("RC01（前导零）", parseVersion("1.0.0-RC01"));

// 4) 进位：patch 超 10 → 1.1.0；minor 连带超 10 → 2.0.0
expectEqual("1.0.10 bump patch", bumpVersion("1.0.10", "patch").value, "1.1.0");
expectEqual("1.10.10 bump patch", bumpVersion("1.10.10", "patch").value, "2.0.0");
expectEqual("1.0.9 bump patch（不越界）", bumpVersion("1.0.9", "patch").value, "1.0.10");
expectEqual("1.9.9 bump minor", bumpVersion("1.9.9", "minor").value, "1.10.0");
expectEqual("1.10.0 bump minor（进位到 major）", bumpVersion("1.10.0", "minor").value, "2.0.0");
expectEqual("1.10.10 bump major", bumpVersion("1.10.10", "major").value, "2.0.0");
expectEqual("1.2.3 bump minor 清 patch", bumpVersion("1.2.3", "minor").value, "1.3.0");
expectEqual("alpha 进位后丢弃预发布后缀", bumpVersion("1.0.10-alpha7", "patch").value, "1.1.0");
expectReject("未知段位", bumpVersion("1.0.0", "build"));

// 5) tag 与版本一致
expectReject("tag v1.0.0-alpha2 对版本 1.0.0-alpha1", checkTag(parseVersion("1.0.0-alpha1"), "v1.0.0-alpha2"));
expectReject("tag 缺 v 前缀", checkTag(parseVersion("1.0.0"), "1.0.0"));
expectAccept("tag 一致", checkTag(parseVersion("1.0.0-alpha1"), "v1.0.0-alpha1"));

// 6) latest.json 三平台齐全且版本一致
const okManifest = {
  version: "1.0.0-alpha1",
  platforms: {
    "windows-x86_64": { signature: "sig", url: "https://github.com/yunyu697/albumio/releases/download/v1.0.0-alpha1/a.exe" },
    "darwin-aarch64": { signature: "sig", url: "https://github.com/yunyu697/albumio/releases/download/v1.0.0-alpha1/a.app.tar.gz" },
    "linux-x86_64": { signature: "sig", url: "https://github.com/yunyu697/albumio/releases/download/v1.0.0-alpha1/a.AppImage" },
  },
};
expectAccept("latest.json 合规", checkManifest(parseVersion("1.0.0-alpha1"), okManifest));
expectReject(
  "latest.json 版本不一致",
  checkManifest(parseVersion("1.0.0-alpha2"), okManifest),
);
expectReject(
  "latest.json 缺平台",
  checkManifest(parseVersion("1.0.0-alpha1"), {
    ...okManifest,
    platforms: { ...okManifest.platforms, "linux-x86_64": undefined },
  }),
);
expectReject(
  "latest.json 缺签名",
  checkManifest(parseVersion("1.0.0-alpha1"), {
    ...okManifest,
    platforms: { ...okManifest.platforms, "windows-x86_64": { ...okManifest.platforms["windows-x86_64"], signature: "" } },
  }),
);

// 7) 仓库当前版本必须合规
const version = JSON.parse(readFileSync(join(process.cwd(), "app", "package.json"), "utf8")).version;
expectAccept(`仓库当前版本 ${version}`, parseVersion(version));

console.log(`[version-rules-test] 通过 ${passed} 项，失败 ${failures.length} 项`);
for (const f of failures) console.error(` - ${f}`);
process.exit(failures.length === 0 ? 0 : 1);
