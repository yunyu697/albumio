/**
 * M3 侧栏 / 时间线 / 状态栏的可复跑自检（02-设计规范 §9、§11.7）。
 *
 * 用法（先 `npm run preview -- --port 4173`）：
 *   node scripts/m3-check.mjs
 *
 * 覆盖：侧栏三段（快速访问 / 文件夹树 / 底部磁盘+进度）、目录切换与面包屑、
 * 时间线分组与「推断」标注、切换视图不丢选中与滚动、未选中时的目录摘要、Ctrl+B。
 * 产出：app/docs/acceptance/m3-{folder,timeline}.png 与 design-baseline 同名图。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.PORT ?? 9353);
const URL = process.env.URL ?? "http://[::1]:4173/";
const ROOT = resolve(import.meta.dirname, "..");
const DESIGN = pathToFileURL(join(ROOT, "design/index.html")).href;
const ACC = join(ROOT, "app/docs/acceptance");
const BASE = join(ROOT, "app/docs/design-baseline");
const profile = mkdtempSync(join(tmpdir(), "albumio-m3-"));

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

const STATE = `(() => {
  const txt = (el) => el ? el.textContent.replace(/\\s+/g, ' ').trim() : null;
  const rows = [...document.querySelectorAll('.sidebar .tree-row')].map((r) => ({
    text: txt(r), on: r.classList.contains('on'),
  }));
  const heads = [...document.querySelectorAll('.tl-h')].map((h) => txt(h));
  const stage = document.querySelector('.stage');
  return {
    sections: [...document.querySelectorAll('.side-title')].map(txt),
    rows,
    disk: txt(document.querySelector('.disk')),
    indexNote: txt(document.querySelector('.index-note')),
    crumbs: [...document.querySelectorAll('.crumbs .crumb')].map(txt),
    statusMid: txt(document.querySelector('.sb-mid')),
    statusLeft: txt(document.querySelector('.statusbar')),
    heads,
    tags: [...document.querySelectorAll('.tl-tag')].map(txt),
    tiles: document.querySelectorAll('.tile').length,
    selected: document.querySelectorAll('.tile.sel').length,
    active: document.querySelector('.seg-item.active')?.textContent?.trim() ?? null,
    scrollTop: stage ? Math.round(stage.scrollTop) : null,
    sidebar: !!document.querySelector('.sidebar')
  };
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

  const log = (label, v) => console.log(label, JSON.stringify(v, null, 2));

  /* 1. 侧栏结构与目录摘要 */
  let s = await evalJs(cdp, STATE);
  log("1 侧栏", {
    sections: s.sections,
    rows: s.rows.slice(0, 6),
    disk: s.disk,
    indexNote: s.indexNote,
    crumbs: s.crumbs,
    statusMid: s.statusMid,
    tiles: s.tiles,
    selected: s.selected,
  });
  if (s.sections.length < 2) throw new Error("侧栏缺少分段标题");
  if (!s.disk) throw new Error("侧栏缺少磁盘用量块");
  if (!s.indexNote) throw new Error("侧栏缺少进度条");
  if (s.selected !== 0) throw new Error("进目录后不应默认选中");
  if (!s.statusMid?.includes("项")) throw new Error("未选中时状态栏中段不是目录摘要");
  await shot(cdp, join(ACC, "m3-folder.png"));

  /* 2. 点树里的子目录 → 面包屑与目录跟着变 */
  const before = s.crumbs.at(-1);
  await evalJs(
    cdp,
    `[...document.querySelectorAll('.sidebar .tree-row')].find((r) => r.textContent.includes('2025'))?.click()`
  );
  await sleep(900);
  s = await evalJs(cdp, STATE);
  log("2 切换目录", { crumbs: s.crumbs, tiles: s.tiles, on: s.rows.filter((r) => r.on) });
  if (s.crumbs.at(-1) === before) throw new Error("点树节点后面包屑没变");
  if (!s.rows.some((r) => r.on)) throw new Error("当前目录没有高亮");

  /* 3. 选一个格子，记下选中与滚动 */
  await evalJs(cdp, `document.querySelectorAll('.tile')[0].click()`);
  await evalJs(cdp, `document.querySelector('.stage').scrollTop = 240`);
  await sleep(250);
  s = await evalJs(cdp, STATE);
  const selName = await evalJs(cdp, `document.querySelector('.tile.sel')?.getAttribute('title')`);
  const folderScroll = s.scrollTop;

  /* 4. 切时间线：分组头 + 推断标注 + 状态栏进度 */
  await evalJs(
    cdp,
    `[...document.querySelectorAll('.seg-item')].find((b) => b.textContent.includes('时间线')).click()`
  );
  await sleep(1200);
  s = await evalJs(cdp, STATE);
  log("4 时间线", {
    heads: s.heads,
    tags: s.tags,
    active: s.active,
    status: s.statusLeft,
    tiles: s.tiles,
  });
  if (!s.heads.length) throw new Error("时间线没有分组头");
  if (s.tags.length === 0) throw new Error("时间线缺少「推断 N」标注");
  if (!s.statusLeft.includes("时间线")) throw new Error("状态栏右段没切到时间线进度");
  await shot(cdp, join(ACC, "m3-timeline.png"));
  const appHead = await evalJs(
    cdp,
    `(() => { const h=document.querySelector('.tl-h'); if(!h) return null;
      const r=h.getBoundingClientRect(); const cs=getComputedStyle(h);
      const row=h.nextElementSibling; const rr=row?.getBoundingClientRect();
      return { h: Math.round(r.height*100)/100, padTop: cs.paddingTop, padBottom: cs.paddingBottom,
               toRow: rr ? Math.round((rr.top - r.top)*100)/100 : null }; })()`
  );
  console.log("4 分组头几何（应用）", appHead);
  if (!appHead || Math.abs(appHead.h - 32) > 1) throw new Error(`分组头高度偏离 §11.7：${appHead?.h}`);
  if (appHead.toRow !== 32) throw new Error(`分组头到首行应为 32，实际 ${appHead.toRow}`);

  /* 4b. 滚动后粘性头吸附在画布顶 */
  await evalJs(cdp, `document.querySelector('.stage').scrollTop = 320`);
  await sleep(300);
  const pin = await evalJs(
    cdp,
    `(() => { const p=document.querySelector('.tl-h.tl-pin'); const st=document.querySelector('.stage');
      if(!p) return null; return { text:p.textContent.replace(/\\s+/g,' ').trim(),
        top: Math.round(p.getBoundingClientRect().top - st.getBoundingClientRect().top) }; })()`
  );
  console.log("4b 粘性头", pin);
  if (!pin) throw new Error("滚动后没有粘性分组头");
  if (Math.abs(pin.top) > 1) throw new Error(`粘性头未吸附在顶部：${pin.top}`);

  /* 5. 切回文件夹：选中与滚动都还在 */
  await evalJs(
    cdp,
    `[...document.querySelectorAll('.seg-item')].find((b) => b.textContent.includes('文件夹')).click()`
  );
  await sleep(900);
  s = await evalJs(cdp, STATE);
  log("5 切回文件夹", { selected: s.selected, scrollTop: s.scrollTop, expect: folderScroll });
  if (s.selected !== 1) throw new Error("切回文件夹后选中丢了");
  if (!selName) throw new Error("选中项丢了名字");
  if (Math.abs((s.scrollTop ?? 0) - folderScroll) > 4) throw new Error("切回文件夹后滚动位置丢了");

  /* 6. Ctrl+B 收起/展开侧栏 */
  const KEY = (key, extra = {}) => `(() => {
    document.body.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({
      key,
      bubbles: true,
      ...extra,
    })}));
  })()`;
  await evalJs(cdp, KEY("b", { ctrlKey: true }));
  await sleep(200);
  let off = await evalJs(cdp, `!!document.querySelector('.sidebar')`);
  if (off) throw new Error("Ctrl+B 没有收起侧栏");
  await evalJs(cdp, KEY("b", { ctrlKey: true }));
  await sleep(200);
  let on = await evalJs(cdp, `!!document.querySelector('.sidebar')`);
  if (!on) throw new Error("Ctrl+B 没有恢复侧栏");
  console.log("6 Ctrl+B", { off, on });

  /* 7. 空选中（Esc）后状态栏回到目录摘要 */
  await evalJs(cdp, `document.querySelector('.stage').focus()`);
  await evalJs(cdp, `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  s = await evalJs(cdp, STATE);
  console.log("7 Esc 后状态栏", { statusMid: s.statusMid, selected: s.selected });
  if (s.selected !== 0) throw new Error("Esc 没有清空选中");
  if (!s.statusMid?.includes("项")) throw new Error("Esc 后中段不是目录摘要");

  /* 8. 设计稿基准图（G3 对照用，含设计稿顶部 .specbar 44px） */
  await cdp.send("Page.navigate", { url: DESIGN });
  await sleep(1200);
  for (const [view, name] of [
    ["folder", "m3-folder"],
    ["timeline", "m3-timeline"],
  ]) {
    await evalJs(
      cdp,
      `document.querySelector('.app .seg-item[data-view="${view}"]')?.click()`
    );
    await sleep(500);
    await shot(cdp, join(BASE, `${name}.png`));
  }
  const dHead = await evalJs(
    cdp,
    `(() => { const h=document.querySelector('.tl-h'); if(!h) return null;
      const r=h.getBoundingClientRect(); const cs=getComputedStyle(h);
      const row=h.nextElementSibling; const rr=row?.getBoundingClientRect();
      return { h: Math.round(r.height*100)/100, padTop: cs.paddingTop, padBottom: cs.paddingBottom,
               toRow: rr ? Math.round((rr.top - r.top)*100)/100 : null }; })()`
  );
  console.log("8 分组头几何（设计稿）", dHead);
  if (dHead && appHead && Math.abs(dHead.h - appHead.h) > 1) {
    throw new Error(`分组头高度与设计稿不一致：应用 ${appHead.h} / 设计稿 ${dHead.h}`);
  }

  console.log("\nM3 自检全部通过");
} finally {
  proc.kill();
}
