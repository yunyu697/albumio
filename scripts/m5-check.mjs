/**
 * M5 全屏看图的可复跑自检（02-设计规范 §10.3、§11.1、§11.2；04-项目计划 M5）。
 *
 * 用法（先 `npm run preview -- --port 4173`）：
 *   node scripts/m5-check.mjs
 *
 * 覆盖：浮条 40/顶 12、胶片条 72/单格 56、缩放条位置与高度、信息浮层宽 280、
 * 舞台 padding 64/32/96、翻页不出现空帧、100% = L2 1:1、400% 仍用 L2、
 * 浮条静止 2.5s 淡出与键盘唤回、Esc 关闭后网格键位恢复，以及与设计稿的几何对照。
 * 产出：app/docs/acceptance/m5-*.png 与 app/docs/design-baseline/m5-viewer.png。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.PORT ?? 9354);
const URL = process.env.URL ?? "http://[::1]:4173/";
const ROOT = resolve(import.meta.dirname, "..");
const DESIGN = pathToFileURL(join(ROOT, "design/index.html")).href;
const ACC = join(ROOT, "app/docs/acceptance");
const BASE = join(ROOT, "app/docs/design-baseline");
const profile = mkdtempSync(join(tmpdir(), "albumio-m5-"));

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

const KEY = (key, extra = {}) => `(() => {
  document.body.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({
    key,
    bubbles: true,
    ...extra,
  })}));
})()`;

/** 相对窗口量 overlay 内各块；设计稿用 .app 的矩形当参照，去掉 44px 外层导航的偏移。 */
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
  const item = document.querySelector('.film-item');
  const ib = item?.getBoundingClientRect();
  const photo = document.querySelector('.v-photo img');
  return {
    href: location.href,
    app: document.querySelector('.app') ? true : false,
    top: box('.v-top', '.app'),
    topH: box('.floatbar', '.app'),
    stage: box('.v-stage', '.app'),
    zoom: box('.v-zoom', '.app'),
    film: box('.film', '.app'),
    filmItem: ib ? { w: +ib.width.toFixed(2), h: +ib.height.toFixed(2) } : null,
    info: box('.v-info', '.app'),
    count: document.querySelector('.fb-count')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
    title: document.querySelector('.fb-title')?.textContent.trim() ?? null,
    pct: document.querySelector('.v-zoom .pct')?.textContent.trim() ?? null,
    photo: photo ? { natW: photo.naturalWidth, cssW: +photo.getBoundingClientRect().width.toFixed(2) } : null,
    imgCount: document.querySelectorAll('.v-photo img').length,
    filmItems: document.querySelectorAll('.film-item').length,
  };
})()`;

const near = (a, b, tol, label) => {
  if (a === null || a === undefined || Math.abs(a - b) > tol) {
    throw new Error(`${label} 期望 ${b}±${tol}，实际 ${a}`);
  }
};

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

  /* 1. 打开全屏看图 */
  await evalJs(cdp, `document.querySelectorAll('.tile')[0].click()`);
  await evalJs(cdp, KEY("Enter"));
  await sleep(900);
  let g = await evalJs(cdp, GEO);
  console.log("1 打开 viewer", JSON.stringify(g, null, 2));
  if (!g.top || !g.stage) throw new Error("viewer 没打开");
  near(g.top.top, 12, 1, "浮条距顶");
  near(g.top.left, 12, 1, "浮条距左");
  near(g.top.right, 12, 1, "浮条距右");
  near(g.top.h, 40, 1, "浮条高度");
  near(g.stage.padTop, 64, 1, "舞台上内边距");
  near(g.stage.padBottom, 96, 1, "舞台下内边距");
  near(g.stage.padLeft, 32, 1, "舞台左内边距");
  near(g.film.h, 72, 1, "胶片条高度");
  near(g.film.bottom, 12, 1, "胶片条距底");
  near(g.filmItem.w, 56, 0.5, "胶片单格宽");
  near(g.filmItem.h, 56, 0.5, "胶片单格高");
  near(g.zoom.h, 40, 1, "缩放条高度");
  near(g.zoom.bottom, 90, 1, "缩放条距底");
  near(g.zoom.right, 12, 1, "缩放条距右");
  if (!g.count || !g.title) throw new Error("浮条缺少文件名/计数");
  if (!g.photo || g.photo.natW !== 2048) throw new Error(`首图不是 L2 代理：${g.photo?.natW}`);
  await shot(cdp, join(ACC, "m5-viewer.png"));

  /* 2. 信息浮层 */
  await evalJs(cdp, KEY("i"));
  await sleep(250);
  const infoGeo = await evalJs(cdp, GEO);
  console.log("2 信息浮层", { href: infoGeo.href, info: infoGeo.info });
  near(infoGeo.info.w, 280, 1, "信息浮层宽度");
  near(infoGeo.info.top, 58, 1, "信息浮层距顶");
  await shot(cdp, join(ACC, "m5-info.png"));
  await evalJs(cdp, KEY("i"));
  await sleep(150);

  /* 3. 翻页：每步都要求已有一张 L2 在屏上（不出现空帧） */
  const steps = [];
  for (let i = 0; i < 8; i++) {
    await evalJs(cdp, KEY("ArrowRight"));
    await sleep(90);
    steps.push(
      await evalJs(
        cdp,
        `(() => { const im=document.querySelector('.v-photo img');
          return { imgs: document.querySelectorAll('.v-photo img').length,
                   complete: !!im?.complete, natW: im?.naturalWidth ?? 0,
                   count: document.querySelector('.fb-count')?.textContent.replace(/\\s+/g,' ').trim() ?? null }; })()`
      )
    );
  }
  console.log("3 连续翻页", steps);
  if (steps.some((s) => s.imgs !== 1 || !s.complete || s.natW !== 2048)) {
    throw new Error("翻页过程中出现了空帧或非 L2 图");
  }
  near(steps.at(-1).count?.split("/")[0].trim(), 9, 0, "翻页后计数");

  /* 4. 实际像素 / 400% / 适应 */
  await evalJs(cdp, KEY("z"));
  await sleep(250);
  g = await evalJs(cdp, GEO);
  console.log("4a 实际像素", { pct: g.pct, photo: g.photo });
  if (g.pct !== "100%") throw new Error(`Z 之后不是 100%：${g.pct}`);
  if (g.photo.natW !== 2048) throw new Error("100% 的源不是 L2");
  if (Math.abs(g.photo.cssW - 2048) > 5) throw new Error(`100% 时 CSS 宽应为 2048，实际 ${g.photo.cssW}`);

  for (let i = 0; i < 7; i++) await evalJs(cdp, KEY("+"));
  await sleep(300);
  g = await evalJs(cdp, GEO);
  const pct400 = Number((g.pct ?? "").replace("%", ""));
  console.log("4b 放大 7 档", { pct: g.pct, photo: g.photo });
  if (pct400 < 400) throw new Error(`放大 7 档应 ≥400%，实际 ${g.pct}`);
  if (g.photo.natW !== 2048) throw new Error("400% 时源已不是 L2");
  await shot(cdp, join(ACC, "m5-zoom400.png"));

  await evalJs(cdp, KEY("f"));
  await sleep(250);
  g = await evalJs(cdp, GEO);
  console.log("4c 适应窗口", { pct: g.pct, photo: g.photo });
  if (Number((g.pct ?? "").replace("%", "")) >= 100) throw new Error("适应窗口没有缩回");
  near(g.photo.cssW, 2048 * (Number((g.pct ?? "0%").replace("%", "")) / 100), 6, "适应后显示宽");

  /* 5. 胶片条点击 */
  const before = g.count;
  await evalJs(cdp, `document.querySelectorAll('.film-item')[3]?.click()`);
  await sleep(500);
  g = await evalJs(cdp, GEO);
  console.log("5 胶片条", { before, after: g.count });
  if (g.count === before) throw new Error("点胶片条没有换图");

  /* 6. 浮条 2.5s 淡出，键盘唤回 */
  await evalJs(
    cdp,
    `document.querySelector('.overlay').dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))`
  );
  await sleep(3000);
  const hidden = await evalJs(
    cdp,
    `getComputedStyle(document.querySelector('.v-top')).opacity`
  );
  await evalJs(cdp, KEY("ArrowRight"));
  await sleep(200);
  const shown = await evalJs(
    cdp,
    `getComputedStyle(document.querySelector('.v-top')).opacity`
  );
  console.log("6 浮条淡出/唤回", { hidden, shown });
  if (Number(hidden) > 0.05) throw new Error(`静止 3s 后浮条未淡出：opacity=${hidden}`);
  if (Number(shown) < 0.95) throw new Error(`键盘操作未唤回浮条：opacity=${shown}`);

  /* 7. Esc 关闭，网格键位恢复 */
  await evalJs(cdp, KEY("Escape"));
  await sleep(300);
  const closed = await evalJs(cdp, `!document.querySelector('.overlay')`);
  if (!closed) throw new Error("Esc 没有关闭 viewer");
  const selBefore = await evalJs(cdp, `document.querySelectorAll('.tile.sel').length`);
  await evalJs(cdp, KEY("ArrowRight"));
  await sleep(200);
  const selAfter = await evalJs(cdp, `document.querySelectorAll('.tile.sel').length`);
  console.log("7 Esc 关闭", { closed, selBefore, selAfter });
  if (!closed || selAfter !== 1) throw new Error("关闭 viewer 后网格键位未恢复");

  /* 8. 设计稿基准 */
  await cdp.send("Page.navigate", { url: DESIGN });
  await sleep(1200);
  await evalJs(
    cdp,
    `document.querySelector('.spec-tab[data-screen="viewer"]')?.click()`
  );
  await sleep(700);
  const d = await evalJs(cdp, GEO);
  console.log("8 设计稿几何", JSON.stringify(d, null, 2));
  await shot(cdp, join(BASE, "m5-viewer.png"));
  // 设计稿的信息浮层默认收起，量宽度前临时展开（截图之后，不影响基准图）。
  const dInfoW = await evalJs(
    cdp,
    `(() => { const e=document.querySelector('.v-info'); if(!e) return null;
      e.style.display='block'; const w=e.getBoundingClientRect().width; e.style.display='';
      return +w.toFixed(2); })()`
  );
  console.log("8 设计稿信息宽度", dInfoW);
  const pairs = [
    ["浮条高度", g.top.h, d.top.h],
    ["舞台上内边距", Number(g.stage.padTop), Number(d.stage.padTop)],
    ["舞台下内边距", Number(g.stage.padBottom), Number(d.stage.padBottom)],
    ["舞台左内边距", Number(g.stage.padLeft), Number(d.stage.padLeft)],
    ["胶片条高度", g.film.h, d.film.h],
    ["胶片单格宽", g.filmItem.w, d.filmItem.w],
    ["缩放条距底", g.zoom.bottom, d.zoom.bottom],
    ["信息浮层宽", infoGeo.info.w, dInfoW],
  ];
  for (const [label, a, b] of pairs) near(a, b, 1, label);

  console.log("\nM5 自检全部通过");
} finally {
  proc.kill();
}
