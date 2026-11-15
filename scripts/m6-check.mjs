/**
 * M6 屏 3 的可复跑自检（02-设计规范 §10.4、§11.4；04-项目计划 M6）。
 *
 * 用法（先 `npm run preview -- --port 4173`）：
 *   node scripts/m6-check.mjs
 *
 * 覆盖：面板宽 280 / 底栏 40 且右让 280、浮条 40、操作栈行高 28、比例按钮 24、
 * 滑杆组块高与标题、裁剪框百分比定位、移除步骤后行变暗且计数减一、恢复、
 * Esc 先退裁剪再关闭、与设计稿的几何对照。
 * 产出：app/docs/acceptance/m6-edit.png 与 app/docs/design-baseline/m6-edit.png。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.PORT ?? 9356);
const URL = process.env.URL ?? "http://[::1]:4173/";
const ROOT = resolve(import.meta.dirname, "..");
const DESIGN = pathToFileURL(join(ROOT, "design/index.html")).href;
const ACC = join(ROOT, "app/docs/acceptance");
const BASE = join(ROOT, "app/docs/design-baseline");
const profile = mkdtempSync(join(tmpdir(), "albumio-m6-"));

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
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};

async function shot(cdp, path) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path, Buffer.from(s.result.data, "base64"));
}

const KEY = (key, extra = {}) => `(() => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({
    key,
    bubbles: true,
    ...extra,
  })}));
})()`;

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
      padTop: cs.paddingTop, padBottom: cs.paddingBottom,
      padLeft: cs.paddingLeft, padRight: cs.paddingRight,
    };
  };
  const op = document.querySelector('.op-row');
  const ratio = document.querySelector('.ratio');
  const slider = document.querySelector('.slider-block');
  const title = document.querySelector('.e-panel .insp-title');
  const crop = document.querySelector('.crop');
  const fb = document.querySelector('.e-frame');
  const fr = fb?.getBoundingClientRect();
  const cr = crop?.getBoundingClientRect();
  return {
    href: location.href,
    top: box('.overlay.editor .v-top, #ov-edit .v-top', '.app'),
    panel: box('.e-panel', '.app'),
    bar: box('.e-bar', '.app'),
    opRow: op ? { h: +op.getBoundingClientRect().height.toFixed(2) } : null,
    ratio: ratio ? { h: +ratio.getBoundingClientRect().height.toFixed(2) } : null,
    slider: slider ? { h: +slider.getBoundingClientRect().height.toFixed(2) } : null,
    title: title ? { h: +title.getBoundingClientRect().height.toFixed(2), size: getComputedStyle(title).fontSize } : null,
    frame: fr ? { w: +fr.width.toFixed(2), h: +fr.height.toFixed(2) } : null,
    crop: fr && cr
      ? {
          x: +((cr.left - fr.left) / fr.width * 100).toFixed(2),
          y: +((cr.top - fr.top) / fr.height * 100).toFixed(2),
          w: +(cr.width / fr.width * 100).toFixed(2),
          h: +(cr.height / fr.height * 100).toFixed(2),
        }
      : null,
    count: document.querySelector('.fb-count:last-of-type')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
    titleText: document.querySelector('.fb-title')?.textContent.trim() ?? null,
    rows: [...document.querySelectorAll('.op-row')].map((r) => ({
      text: r.textContent.replace(/\\s+/g, ' ').trim(),
      off: r.classList.contains('off'),
    })),
    img: (() => { const i = document.querySelector('.e-frame img');
      return i ? { complete: i.complete, natW: i.naturalWidth, cssW: +i.getBoundingClientRect().width.toFixed(2) } : null; })(),
    note: document.querySelector('.e-note')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
  };
})()`;

const near = (a, b, tol, label) => {
  if (a === null || a === undefined || Math.abs(a - b) > tol) {
    throw new Error(`${label} 期望 ${b}±${tol}，实际 ${a}`);
  }
};

/** 给受控 range 设值：必须用原生 setter 再派发 input，React 才认。 */
const setRange = (label, value) => `(() => {
  const block = [...document.querySelectorAll('.slider-block')]
    .find((b) => b.querySelector('.slider-top span')?.textContent.trim() === ${JSON.stringify(label)});
  const input = block?.querySelector('input[type=range]');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, '${value}');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

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
  await cdp.send("Page.navigate", { url: URL });
  await sleep(1800);

  /* 1. 从网格先打开看图，再按 E 进入编辑（§10.3 → §10.4 的入口顺序） */
  await evalJs(cdp, `document.querySelectorAll('.tile')[0].click()`);
  await evalJs(cdp, KEY("Enter"));
  await sleep(700);
  await evalJs(cdp, KEY("e"));
  await sleep(1100);
  let g = await evalJs(cdp, GEO);
  console.log("1 打开编辑", JSON.stringify(g, null, 2));
  if (!g.panel || !g.bar) throw new Error("编辑界面没打开");
  near(g.panel.w, 280, 1, "右侧面板宽");
  near(g.bar.h, 40, 1, "底栏高度");
  near(g.bar.bottom, 12, 1, "底栏距底");
  near(g.bar.left, 12, 1, "底栏距左");
  near(g.bar.right, 292, 1, "底栏右侧让出面板");
  near(g.top.h, 40, 1, "浮条高度");
  near(g.opRow.h, 28, 0.5, "操作栈行高");
  near(g.ratio.h, 24, 0.5, "比例按钮高");
  near(g.title.size, "11px", 0, "小节标题字号");
  if (!g.crop) throw new Error("裁剪框没有渲染");
  near(g.crop.x, 10, 0.6, "裁剪框左（%）");
  near(g.crop.y, 12, 0.6, "裁剪框上（%）");
  near(g.crop.w, 80, 0.6, "裁剪框宽（%）");
  near(g.crop.h, 76, 0.6, "裁剪框高（%）");
  if (!g.img || !g.img.complete || g.img.natW === 0) throw new Error("预览图未上屏");
  if (!(g.note ?? "").includes("原图未修改")) throw new Error("底栏缺少非破坏性说明");

  /* 2. 旋转 + 三个滑杆 → 操作栈出现 5 步 */
  await evalJs(cdp, KEY("r"));
  await sleep(120);
  if (!(await evalJs(cdp, setRange("曝光", 35)))) throw new Error("找不到曝光滑杆");
  if (!(await evalJs(cdp, setRange("对比度", 12)))) throw new Error("找不到对比度滑杆");
  if (!(await evalJs(cdp, setRange("锐化", 40)))) throw new Error("找不到锐化滑杆");
  await sleep(700);
  g = await evalJs(cdp, GEO);
  console.log("2 操作栈", { count: g.count, rows: g.rows });
  if (g.rows.length !== 5) throw new Error(`操作栈应有 5 行，实际 ${g.rows.length}`);
  if (!(g.count ?? "").includes("5 个操作")) throw new Error(`计数不对：${g.count}`);
  await shot(cdp, join(ACC, "m6-edit.png"));

  /* 3. 移除一步 → 变暗、计数减一；再点恢复 */
  await evalJs(cdp, `document.querySelectorAll('.op-row')[2].querySelector('.op-x').click()`);
  await sleep(200);
  g = await evalJs(cdp, GEO);
  console.log("3 移除一步", { count: g.count, rows: g.rows.map((r) => r.off) });
  if (!g.rows[2].off) throw new Error("被移除的行没有变暗");
  if (!(g.count ?? "").includes("4 个操作")) throw new Error(`移除后计数未减一：${g.count}`);
  await evalJs(cdp, `document.querySelectorAll('.op-row')[2].querySelector('.op-x').click()`);
  await sleep(200);
  g = await evalJs(cdp, GEO);
  if (g.rows[2].off) throw new Error("恢复后仍处于停用态");
  if (!(g.count ?? "").includes("5 个操作")) throw new Error(`恢复后计数未回到 5：${g.count}`);

  /* 4. Esc 先退出裁剪，再 Esc 关闭编辑 */
  await evalJs(cdp, KEY("Escape"));
  await sleep(200);
  g = await evalJs(cdp, GEO);
  const noCrop = await evalJs(cdp, `!document.querySelector('.crop')`);
  const stillEditor = await evalJs(cdp, `!!document.querySelector('.e-panel')`);
  console.log("4 Esc 退裁剪", { noCrop, stillEditor, count: g.count });
  if (!noCrop || !stillEditor) throw new Error("第一次 Esc 应只退出裁剪");
  await evalJs(cdp, KEY("Escape"));
  await sleep(300);
  const closed = await evalJs(cdp, `!document.querySelector('.e-panel')`);
  const gridBack = await evalJs(cdp, `!!document.querySelector('.grid, .tiles, .tile')`);
  console.log("4b Esc 关闭", { closed, gridBack });
  if (!closed || !gridBack) throw new Error("第二次 Esc 应关闭编辑回到网格");

  /* 5. 设计稿基准 */
  await cdp.send("Page.navigate", { url: DESIGN });
  await sleep(1200);
  await evalJs(
    cdp,
    `document.querySelector('.spec-tab[data-screen="edit"]')?.click()`
  );
  await sleep(700);
  const d = await evalJs(cdp, GEO);
  console.log("5 设计稿几何", JSON.stringify(d, null, 2));
  await shot(cdp, join(BASE, "m6-edit.png"));

  const pairs = [
    ["浮条高度", g.top.h, d.top.h],
    ["右侧面板宽", g.panel.w, d.panel.w],
    ["底栏高度", g.bar.h, d.bar.h],
    ["底栏距底", g.bar.bottom, d.bar.bottom],
    ["操作栈行高", g.opRow.h, d.opRow.h],
    ["比例按钮高", g.ratio.h, d.ratio.h],
    ["小节标题字号", parseFloat(g.title.size), parseFloat(d.title.size)],
  ];
  for (const [label, a, b] of pairs) near(a, b, 1, label);

  console.log("\nM6 自检全部通过（裁剪框默认 10/12/80/76%，与设计稿 12%/10% 的 inset 同一矩形）");
} finally {
  proc.kill();
}
