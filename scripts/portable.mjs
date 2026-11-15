#!/usr/bin/env node
/**
 * Windows portable 包（04-项目计划 M9）。
 *
 * portable = 解压即用、不写注册表；与 MSI/NSIS 共用同一份 release 产物。
 * 用法（仓库根或 app/ 下均可）：
 *   node scripts/portable.mjs               # exe 不存在时先 `tauri build --no-bundle`
 *   node scripts/portable.mjs --skip-build  # 只用现有 target/release/albumio.exe
 * 产物：app/dist-portable/albumio-<version>-windows-x64.zip
 */
import { execFileSync, execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const cwd = process.cwd();
const appDir = existsSync(join(cwd, "src-tauri")) ? cwd : join(cwd, "app");
const root = appDir === cwd ? resolve(cwd, "..") : cwd;
const skipBuild = process.argv.includes("--skip-build");

if (process.platform !== "win32") {
  console.error("[portable] 只在 Windows 上生成（MSI/AppImage/deb 走 CI 的对应平台）。");
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")).version;
const exe = join(appDir, "src-tauri", "target", "release", "albumio.exe");

if (!existsSync(exe)) {
  if (skipBuild) {
    console.error(`[portable] 找不到 ${exe}，且指定了 --skip-build。请先 npm run tauri build -- --no-bundle`);
    process.exit(1);
  }
  console.log("[portable] 未找到 release 产物，先构建（不打包安装器）…");
  execSync("npm run tauri build -- --no-bundle", { cwd: appDir, stdio: "inherit", shell: true });
}

const outDir = join(appDir, "dist-portable", `albumio-${version}-windows-x64`);
const zip = join(appDir, "dist-portable", `albumio-${version}-windows-x64.zip`);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

copyFileSync(exe, join(outDir, "albumio.exe"));
// WebView2Loader 等运行期 DLL 若被动态链接，跟着 exe 一起走，portable 才不会缺件。
const releaseDir = join(appDir, "src-tauri", "target", "release");
for (const name of readdirSync(releaseDir)) {
  if (name.toLowerCase().endsWith(".dll")) {
    copyFileSync(join(releaseDir, name), join(outDir, name));
  }
}

writeFileSync(
  join(outDir, "使用说明.txt"),
  [
    `Albumio ${version} · Windows x64 portable`,
    "",
    "1. 解压到任意目录，双击 albumio.exe 运行。",
    "2. 不写注册表、不建开始菜单；删除整个目录即卸载。",
    "3. 需要 WebView2 运行时：Windows 11 自带；Windows 10 缺失时请安装 Microsoft Edge WebView2 Runtime。",
    "4. 需要文件关联 / 右键菜单 / 干净卸载，请使用 MSI 或 NSIS 安装包。",
    "",
  ].join("\r\n"),
  "utf8"
);

execFileSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${join(outDir, "*")}' -DestinationPath '${zip}' -Force`,
  ],
  { stdio: "inherit" }
);

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`[portable] exe  ${mb(join(outDir, "albumio.exe"))} MB`);
console.log(`[portable] zip  ${mb(zip)} MB → ${zip}`);
console.log(`[portable] 解压目录 → ${outDir}`);
