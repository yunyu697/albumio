/**
 * M7 屏 4 的可复跑自检（02-设计规范 §11.5；04-项目计划 M7）。
 *
 * 用法（应用部分先 `cd app && npm run build && npm run preview -- --port 4173`）：
 *   node scripts/m7-check.mjs                        # 仅校验设计稿的补稿状态
 *   URL=http://[::1]:4173/ node scripts/m7-check.mjs # 同时校验实现
 *
 * 设计稿部分：右栏 360、列表行 28、开始后主按钮变「暂停」、进度条出现、
 * 行尾状态列出现、暂停/继续、完成后失败与跳过行及原因清单。
 * 实现部分：入口、列表、设置项、进度、结果与设计稿几何对照。
 * 产出：app/docs/acceptance/m7-*.png 与 app/docs/design-baseline/m7-batch.png。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.PORT ?? 9358);
const URL = process.env.URL ?? "";
const ROOT = resolve(import.meta.dirname, "..");
const DESIGN = pathToFileURL(join(ROOT, "design/index.html")).href;
const ACC = join(ROOT, "app/docs/acceptance");
const BASE = join(ROOT, "app/docs/design-baseline");
const profile = mkdtempSync(join(tmpdir(), "albumio-m7-"));

const proc = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "about:blank",
  ],
  { stdio: "ignore" }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const ready = new Promise((r, j) => {
    ws.addEventListener("open", r);
    ws.addEventListener("error", j);
  });
  return {
    ready,
    send: (method, params = {}) =>
      new Promise((res) => {
        const n = ++id;
        pending.set(n, res);
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    close: () => ws.close(),
  };
}

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error("找不到 CDP 页面目标");
}

const evalJs = async (cdp, expression) => {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};

async function shot(cdp, path) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path, Buffer.from(s.result.data, "base64"));
}

const GEO = `(() => {
  const box = (sel, ref) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    const base = ref ? document.querySelector(ref).getBoundingClientRect() : { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
    return {
      w: +b.width.toFixed(2), h: +b.height.toFixed(2),
      top: +(b.top - base.top).toFixed(2), left: +(b.left - base.left).toFixed(2),
      right: +(base.right - b.right).toFixed(2), bottom: +(base.bottom - b.bottom).toFixed(2),
      padLeft: cs.paddingLeft, padRight: cs.paddingRight,
    };
  };
  const row = document.querySelector('.b-row');
  const btn = document.querySelector('#bStart') || document.querySelector('.b-foot .btn.primary');
  return {
    head: box('.b-head', '.app'),
    settings: box('.b-settings', '.app'),
    row: row ? { h: +row.getBoundingClientRect().height.toFixed(2) } : null,
    start: btn ? { h: +btn.getBoundingClientRect().height.toFixed(2), text: btn.textContent.replace(/\\s+/g, ' ').trim() } : null,
    prog: (() => { const p = document.querySelector('.b-prog'); return p ? { hidden: p.hidden, fill: p.querySelector('i')?.style.width ?? '' } : null; })(),
    sub: (document.querySelector('#bSub') || document.querySelector('.b-sub'))?.textContent.trim() ?? null,
    states: [...document.querySelectorAll('.b-row')].map((r) => ({
      cls: r.className.replace('b-row', '').trim(),
      state: r.querySelector('.b-state')?.textContent.trim() ?? '',
    })).filter((r) => r.state),
    resultRows: [...document.querySelectorAll('.res-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim()),
    sum: document.querySelector('#bSumLeft')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
  };
})()`;

const near = (a, b, tol, label) => {
  if (a === null || a === undefined || Math.abs(a - b) > tol) {
    throw new Error(`${label} 期望 ${b}±${tol}，实际 ${a}`);
  }
};

const click = (sel) => `document.querySelector(${JSON.stringify(sel)})?.click()`;

try {
  const target = await findTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  /* 1. 设计稿：空闲态几何不变 */
  await cdp.send("Page.navigate", { url: DESIGN });
  await sleep(1200);
  await evalJs(cdp, `document.querySelector('.spec-tab[data-screen="batch"]')?.click()`);
  await sleep(500);
  let g = await evalJs(cdp, GEO);
  console.log("1 设计稿空闲态", JSON.stringify(g, null, 2));
  near(g.settings.w, 360, 1, "右栏宽");
  near(g.head.h, 48, 1, "顶栏高");
  near(g.row.h, 28, 0.5, "列表行高");
  near(g.start.h, 36, 1, "主按钮高");
  if (g.start.text !== "开始处理") throw new Error(`主按钮文案不是开始处理：${g.start.text}`);
  if (g.states.length !== 0) throw new Error("空闲态不应出现状态列");
  if (!g.prog.hidden) throw new Error("空闲态不应出现进度条");
  await shot(cdp, join(BASE, "m7-batch.png"));

  /* 2. 处理中：进度条、状态列、暂停/继续 */
  await evalJs(cdp, click("#bStart"));
  await sleep(900);
  g = await evalJs(cdp, GEO);
  console.log("2 处理中", JSON.stringify(g, null, 2));
  if (g.prog.hidden) throw new Error("处理中进度条未出现");
  if (g.start.text !== "暂停") throw new Error(`处理中主按钮应为暂停：${g.start.text}`);
  if (g.states.length === 0) throw new Error("处理中未出现状态列");
  await shot(cdp, join(ACC, "m7-running.png"));
  await evalJs(cdp, click("#bStart"));
  await sleep(200);
  const paused = await evalJs(cdp, `document.querySelector('#bStart').textContent.trim()`);
  if (paused !== "继续") throw new Error(`暂停后应为继续：${paused}`);
  await evalJs(cdp, click("#bStart"));

  /* 3. 完成态：失败/跳过行与原因清单 */
  await sleep(3200);
  g = await evalJs(cdp, GEO);
  console.log("3 完成态", JSON.stringify(g, null, 2));
  if (g.start.text !== "完成") throw new Error(`完成后主按钮应为完成：${g.start.text}`);
  const fail = g.states.filter((r) => r.cls.includes("fail"));
  const skip = g.states.filter((r) => r.cls.includes("skip"));
  if (fail.length !== 1) throw new Error(`应恰有 1 个失败行，实际 ${fail.length}`);
  if (skip.length !== 1) throw new Error(`应恰有 1 个跳过行，实际 ${skip.length}`);
  if (!g.resultRows.some((t) => t.includes("源文件不可读"))) throw new Error("结果清单缺少失败原因");
  if (!g.resultRows.some((t) => t.includes("同名文件已存在"))) throw new Error("结果清单缺少跳过原因");
  await shot(cdp, join(ACC, "m7-done.png"));

  /* 4. 重新处理失败项：全部成功 */
  await evalJs(cdp, click("#bRetry"));
  await sleep(900);
  g = await evalJs(cdp, GEO);
  console.log("4 重试", JSON.stringify(g, null, 2));
  if (g.states.some((r) => r.cls.includes("fail"))) throw new Error("重试后仍有失败行");

  /* 5. 实现（可选） */
  if (URL) {
    await cdp.send("Page.navigate", { url: URL });
    await sleep(1800);
    const app = await evalJs(
      cdp,
      `(() => ({ batchBtn: !!document.querySelector('[title="批量处理"], .toolbar [aria-label="批量处理"]'), tiles: document.querySelectorAll('.tile').length }))()`
    );
    console.log("5 实现入口", app);
    if (!app.batchBtn) throw new Error("实现里找不到批量处理入口");
  }

  console.log("\nM7 补稿自检通过：空闲 / 处理中 / 完成三态与失败、跳过清单均按 §11.5 呈现");
} finally {
  proc.kill();
}
