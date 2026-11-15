/**
 * M2 的 G3 可复跑测量：六档宽度下量网格几何并出图。
 *
 * 用法（先 `npm run preview -- --port 4173`）：
 *   node scripts/m2-measure.mjs
 *
 * 输出：每档的列数、格宽、行间距、文件名条高、是否有横向溢出，
 * 以及 1440×900 的实现截图 `app/docs/acceptance/M2-grid-1440.png`。
 * 设计稿基准图已在 `app/docs/design-baseline/browse-dark.png`。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.M2_PORT ?? 9341);
const URL = process.env.M2_URL ?? "http://127.0.0.1:4173/";
const OUT = resolve(import.meta.dirname, "../app/docs/acceptance/M2-grid-1440.png");
const WIDTHS = [1440, 868, 867, 735, 734, 432];
const profile = mkdtempSync(join(tmpdir(), "albumio-m2-"));

const proc = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "about:blank",
], { stdio: "ignore" });

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
  const tiles = [...document.querySelectorAll('.tile')];
  const rows = [...document.querySelectorAll('.grid-row')];
  const firstRowTiles = rows.length ? [...rows[0].querySelectorAll('.tile')] : [];
  const rect = (el) => el ? el.getBoundingClientRect() : null;
  const t0 = rect(tiles[0]);
  const cap = q('.tile-cap');
  const stage = q('.stage');
  const rowGap = rows.length > 1 ? rect(rows[1]).top - rect(rows[0]).top - rect(rows[0]).height : null;
  return {
    width: innerWidth,
    cols: firstRowTiles.length,
    tileW: t0 ? Math.round(t0.width * 100) / 100 : null,
    tileH: t0 ? Math.round(t0.height * 100) / 100 : null,
    captionH: cap ? Math.round(cap.getBoundingClientRect().height * 100) / 100 : null,
    rowPitch: rows.length > 1 ? Math.round((rect(rows[1]).top - rect(rows[0]).top) * 100) / 100 : null,
    rowGap: rowGap === null ? null : Math.round(rowGap * 100) / 100,
    stageW: stage ? Math.round(stage.clientWidth) : null,
    stageScrollW: stage ? stage.scrollWidth : null,
    docScrollW: document.documentElement.scrollWidth,
    titlebarH: q('.titlebar')?.getBoundingClientRect().height ?? null,
    toolbarH: q('.toolbar')?.getBoundingClientRect().height ?? null,
    statusH: q('.statusbar')?.getBoundingClientRect().height ?? null,
    sidebarW: q('.sidebar')?.getBoundingClientRect().width ?? null,
    inspectorW: q('.inspector')?.getBoundingClientRect().width ?? null,
    tiles: tiles.length
  };
})()`;

try {
  const target = await findTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: URL });

  const results = [];
  for (const width of WIDTHS) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(width === WIDTHS[0] ? 1600 : 500);
    const r = await cdp.send("Runtime.evaluate", {
      expression: MEASURE,
      returnByValue: true,
    });
    results.push(r.result.result.value);
  }

  console.log(JSON.stringify(results, null, 2));

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(500);

  /* 五档格宽：用 §10.2 的 -/= 键位切档（与用户操作同一条路径），各量一次。 */
  const CELL_MEASURE = `(() => {
    const row = document.querySelector('.grid-row');
    const tile = document.querySelector('.tile');
    const cs = row ? getComputedStyle(row) : null;
    return {
      cell: tile ? Math.round(tile.getBoundingClientRect().width) : null,
      gap: cs ? cs.columnGap : null,
      cols: row ? row.querySelectorAll('.tile').length : 0,
      rowPitch: (() => {
        const rows = document.querySelectorAll('.grid-row');
        return rows.length > 1
          ? Math.round((rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top) * 100) / 100
          : null;
      })(),
      captionH: Math.round(document.querySelector('.tile-cap')?.getBoundingClientRect().height * 100) / 100
    };
  })()`;
  const press = (key) =>
    cdp.send("Runtime.evaluate", {
      expression: `window.dispatchEvent(new KeyboardEvent('keydown',{key:'${key}',bubbles:true}))`,
      returnByValue: true,
    });
  const measureCell = async () => {
    const r = await cdp.send("Runtime.evaluate", { expression: CELL_MEASURE, returnByValue: true });
    return r.result.result.value;
  };

  const cellResults = [await measureCell()];
  for (let i = 0; i < 4; i++) {
    await press("=");
    await sleep(250);
    cellResults.push(await measureCell());
  }
  for (let i = 0; i < 4; i++) {
    await press("-");
    await sleep(250);
    cellResults.push(await measureCell());
  }
  console.log("五档格宽：", JSON.stringify(cellResults));

  await press("=");
  await sleep(300);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(OUT, Buffer.from(shot.result.data, "base64"));
  console.log("截图：", OUT);
  cdp.close();
} finally {
  proc.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
}
