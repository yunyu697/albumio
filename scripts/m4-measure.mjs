/**
 * M4 的 G3 可复跑测量：屏 5（检查器）几何 + 基准图/实现图。
 *
 * 用法（先 `npm run preview -- --port 4173`，注意 vite 只监听 [::1]）：
 *   node scripts/m4-measure.mjs
 *
 * 产出：
 *   app/docs/design-baseline/inspector-{dark,light}.png   （设计稿裁切）
 *   app/docs/acceptance/M4-inspector-{dark,light}.png     （实现裁切）
 *   app/docs/acceptance/M4-inspector-1440-dark.png        （1440×900 整屏）
 * 同时在 stdout 打印逐项几何，供 M4.md 填表。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const ATTACH = process.env.M4_ATTACH ? Number(process.env.M4_ATTACH) : null;
const PORT = ATTACH ?? Number(process.env.M4_PORT ?? 9342);
const URL = process.env.M4_URL ?? "http://[::1]:4173/";
const ROOT = resolve(import.meta.dirname, "..");
const DESIGN = pathToFileURL(join(ROOT, "design/index.html")).href;
const BASE = join(ROOT, "app/docs/design-baseline");
const ACC = join(ROOT, "app/docs/acceptance");
const profile = mkdtempSync(join(tmpdir(), "albumio-m4-"));
const TAG = ATTACH ? "-live" : "";

const proc = ATTACH
  ? null
  : spawn(
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
      /* 浏览器还没起来 */
    }
    await sleep(250);
  }
  throw new Error("找不到 CDP 页面目标");
}

const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const r = (s) => { const el = q(s); return el ? el.getBoundingClientRect() : null; };
  const px = (v) => (v == null ? null : Math.round(v * 100) / 100);
  const fields = [...document.querySelectorAll('.insp-scroll .field')];
  const scroll = q('.insp-scroll');
  return {
    inspectorW: px(r('.inspector')?.width),
    previewH: px(r('.insp-preview')?.height),
    fieldH: fields.length ? px(fields[0].getBoundingClientRect().height) : null,
    fields: fields.length,
    sectionTitles: [...document.querySelectorAll('.insp-scroll .insp-title')].map(
      (el) => px(el.getBoundingClientRect().height)
    ),
    histH: px(r('.hist')?.height),
    histBars: document.querySelectorAll('.hist-layer:first-child i').length,
    srcTags: document.querySelectorAll('.insp-scroll .src-tag').length,
    scrollW: scroll?.scrollWidth ?? null,
    clientW: scroll?.clientWidth ?? null,
    overflowX: scroll ? scroll.scrollWidth > scroll.clientWidth : null,
    statusMid: q('.sb-mid')?.innerText.replace(/\\s+/g, ' ').trim() ?? null,
    empty: !q('.insp-preview img'),
    titlebarH: px(r('.titlebar')?.height),
    toolbarH: px(r('.toolbar')?.height),
    statusH: px(r('.statusbar')?.height)
  };
})()`;

async function shot(cdp, path) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path, Buffer.from(s.result.data, "base64"));
}

async function clipShot(cdp, selector, path) {
  const r = await cdp.send("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null; const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`,
    returnByValue: true,
  });
  const box = r.result.result.value;
  if (!box) throw new Error(`找不到 ${selector}`);
  const s = await cdp.send("Page.captureScreenshot", {
    format: "png",
    clip: { ...box, scale: 1 },
    captureBeyondViewport: true,
  });
  writeFileSync(path, Buffer.from(s.result.data, "base64"));
}

const theme = (cdp, name) =>
  cdp.send("Runtime.evaluate", {
    expression: `document.documentElement.setAttribute('data-theme', ${JSON.stringify(name)})`,
  });

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

  /* ---------- 实现 ---------- */
  await cdp.send("Page.navigate", { url: URL });
  await sleep(1800);
  await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('.tile')?.click()`,
  });
  await sleep(1200);

  const impl = await cdp.send("Runtime.evaluate", { expression: MEASURE, returnByValue: true });
  console.log("实现：", JSON.stringify(impl.result.result.value, null, 2));

  for (const t of ["dark", "light"]) {
    await theme(cdp, t);
    await sleep(400);
    await clipShot(cdp, ".inspector", join(ACC, `M4-inspector${TAG}-${t}.png`));
    if (t === "dark") await shot(cdp, join(ACC, `M4-inspector-1440${TAG}-dark.png`));
  }

  // 检查器下半段（直方图/标签/位置）在设计稿与实现里都在首屏之外，单独滚动对照。
  await theme(cdp, "dark");
  await cdp.send("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector('.insp-scroll'); if (el) el.scrollTop = el.scrollHeight; })()`,
  });
  await sleep(400);
  await shot(cdp, join(ACC, `M4-inspector-1440${TAG}-dark-bottom.png`));

  /* ---------- 设计稿基准 ---------- */
  if (ATTACH) {
    console.log("（attach 模式：实机 WebView2 不生成设计稿基准图）");
    cdp.close();
    process.exit(0);
  }
  await cdp.send("Runtime.evaluate", { expression: "location.href" });
  await cdp.send("Page.navigate", { url: DESIGN });
  await sleep(1200);
  for (const t of ["dark", "light"]) {
    await theme(cdp, t);
    await sleep(350);
    await clipShot(cdp, "#inspector", join(BASE, `inspector-${t}.png`));
  }
  await theme(cdp, "dark");
  await cdp.send("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector('#inspector .insp-scroll'); if (el) el.scrollTop = el.scrollHeight; })()`,
  });
  await sleep(350);
  await clipShot(cdp, "#inspector", join(BASE, "inspector-dark-bottom.png"));

  console.log("图已写入：");
  for (const p of [
    join(BASE, "inspector-dark.png"),
    join(BASE, "inspector-light.png"),
    join(ACC, "M4-inspector-dark.png"),
    join(ACC, "M4-inspector-light.png"),
    join(ACC, "M4-inspector-1440-dark.png"),
  ]) {
    console.log(" ", existsSync(p) ? "OK " : "缺失", p);
  }
  cdp.close();
} finally {
  if (proc) proc.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
}
