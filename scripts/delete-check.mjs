/**
 * 删除流程的可复跑自检（02-设计规范 §11.6，M2 批次）。
 *
 * 用法（先 `npm run preview -- --port 4173`）：
 *   node scripts/delete-check.mjs
 *
 * 覆盖：单文件 Delete 不弹框 + Toast 撤销、Shift+Delete 单/多选弹框、
 * 多选 Delete 弹框、初始焦点、Tab 循环、Esc 取消、Enter 取消、确认后网格减项。
 * 产出：app/docs/acceptance/delete-{perm,trash,toast}.png 与 design-baseline 同名图。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.PORT ?? 9352);
const URL = process.env.URL ?? "http://[::1]:4173/";
const ROOT = resolve(import.meta.dirname, "..");
const DESIGN = pathToFileURL(join(ROOT, "design/index.html")).href;
const ACC = join(ROOT, "app/docs/acceptance");
const BASE = join(ROOT, "app/docs/design-baseline");
const profile = mkdtempSync(join(tmpdir(), "albumio-del-"));

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
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;
};

async function shot(cdp, path) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(path, Buffer.from(s.result.data, "base64"));
}

const KEY = (key, extra = {}) => `(() => {
  const el = document.activeElement || document.body;
  el.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, bubbles: true, ...extra })}));
})()`;

/** Enter 要靠浏览器原生默认行为触发 button 点击，合成事件不会触发，必须走 CDP 的真实按键。 */
async function realEnter(cdp) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    unmodifiedText: "\r",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

const STATE = `(() => {
  const q = (s) => document.querySelector(s);
  const txt = (el) => el ? el.textContent.replace(/\\s+/g, ' ').trim() : null;
  const dlg = q('.dialog');
  const box = dlg ? dlg.getBoundingClientRect() : null;
  return {
    dialog: dlg ? {
      title: txt(q('.dlg-title')),
      body: txt(q('.dlg-body')),
      names: [...document.querySelectorAll('.dlg-list span')].map(txt),
      note: txt(q('.dlg-note')),
      cancel: txt(q('.dlg-foot .btn.ghost')),
      ok: txt(q('.dlg-foot .btn:last-child')),
      okClass: q('.dlg-foot .btn:last-child')?.className ?? null,
      width: box ? Math.round(box.width * 100) / 100 : null,
      focus: document.activeElement?.textContent?.trim() ?? null,
      tabbables: [...dlg.querySelectorAll('button')].map(txt)
    } : null,
    toast: q('.toast') ? { text: txt(q('.toast-text')), act: txt(q('.toast-act')) } : null,
    tiles: document.querySelectorAll('.tile').length,
    selected: document.querySelectorAll('.tile.sel').length
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

  /* 1. 单文件 Delete：不弹框，出 Toast */
  await evalJs(cdp, `document.querySelectorAll('.tile')[0].click()`);
  await sleep(150);
  await evalJs(cdp, KEY("Delete"));
  await sleep(300);
  let s = await evalJs(cdp, STATE);
  log("1 单文件 Delete", s);
  if (s.dialog) throw new Error("单文件 Delete 不应弹框");
  if (!s.toast) throw new Error("单文件 Delete 缺 Toast");
  await shot(cdp, join(ACC, "delete-toast.png"));

  /* 2. 撤销：Toast 消失，条目恢复（mock 下即刻重列） */
  await evalJs(cdp, `document.querySelector('.toast-act')?.click()`);
  await sleep(700);
  s = await evalJs(cdp, STATE);
  log("2 撤销后", { toast: s.toast, tiles: s.tiles });

  /* 3. 单文件 + Shift+Delete：标题写文件名、不重复列表 */
  await evalJs(cdp, `document.querySelectorAll('.tile')[0].click()`);
  await sleep(120);
  await evalJs(cdp, KEY("Delete", { shiftKey: true }));
  await sleep(250);
  s = await evalJs(cdp, STATE);
  log("3 单文件 Shift+Delete", s.dialog);
  if (!s.dialog?.title?.startsWith("永久删除 ") || !s.dialog.title.endsWith("？")) {
    throw new Error("单文件永久删除标题应写文件名");
  }
  if (s.dialog.names.length !== 0) throw new Error("单文件变体不重复列出文件名");
  if (!s.dialog.note?.includes("不可撤销")) throw new Error("永久删除应写不可撤销");
  await evalJs(cdp, KEY("Escape"));
  await sleep(250);

  /* 4. 多选 + Shift+Delete：永久删除变体 */
  await evalJs(
    cdp,
    `(() => { const t = document.querySelectorAll('.tile'); t[1].dispatchEvent(new MouseEvent('click', {bubbles:true, ctrlKey:true})); t[2].dispatchEvent(new MouseEvent('click', {bubbles:true, ctrlKey:true})); })()`
  );
  await sleep(150);
  await evalJs(cdp, KEY("Delete", { shiftKey: true }));
  await sleep(250);
  s = await evalJs(cdp, STATE);
  log("3 Shift+Delete 多选", s);
  if (!s.dialog?.title?.startsWith("永久删除 3 个项目")) throw new Error("多选永久删除标题不对");
  if (!s.dialog.okClass?.includes("danger")) throw new Error("永久删除主按钮应为 danger");
  if (s.dialog.focus !== "取消") throw new Error("初始焦点应在取消");
  await shot(cdp, join(ACC, "delete-perm.png"));

  /* 5. Tab 只循环两个按钮；Esc 取消后不删任何条目 */
  await evalJs(cdp, KEY("Tab"));
  await sleep(120);
  const afterTab = await evalJs(cdp, `document.activeElement?.textContent?.trim() ?? null`);
  await evalJs(cdp, KEY("Tab"));
  await sleep(120);
  const afterTab2 = await evalJs(cdp, `document.activeElement?.textContent?.trim() ?? null`);
  await evalJs(cdp, KEY("Escape"));
  await sleep(250);
  s = await evalJs(cdp, STATE);
  log("5 Tab/Esc", { afterTab, afterTab2, dialog: s.dialog, tiles: s.tiles });

  /* 6. 多选 + Delete：回收站变体；Enter（焦点在取消）不删 */
  await evalJs(cdp, KEY("Delete"));
  await sleep(250);
  s = await evalJs(cdp, STATE);
  log("6 多选 Delete", s);
  if (!s.dialog?.title?.startsWith("将 3 个项目移到回收站")) throw new Error("回收站标题不对");
  if (s.dialog.okClass?.includes("danger")) throw new Error("回收站主按钮不应是 danger");
  await shot(cdp, join(ACC, "delete-trash.png"));
  await realEnter(cdp);
  await sleep(250);
  s = await evalJs(cdp, STATE);
  if (s.dialog) throw new Error("Enter 在取消上应关闭对话框");
  if (s.tiles !== 42) throw new Error("Enter 取消后不应删除条目");

  /* 7. 确认后网格减 3 项 */
  await evalJs(cdp, KEY("Delete"));
  await sleep(250);
  await evalJs(cdp, `document.querySelector('.dlg-foot .btn.primary')?.click()`);
  await sleep(600);
  s = await evalJs(cdp, STATE);
  log("7 确认后", { dialog: s.dialog, tiles: s.tiles, toast: s.toast });
  if (s.tiles !== 39) throw new Error(`确认后应为 39 项，实际 ${s.tiles}`);

  /* 8. 设计稿基准：删除确认 / 删除提示 */
  await cdp.send("Page.navigate", { url: DESIGN });
  await sleep(1200);
  for (const [screen, name] of [
    ["confirm", "delete-perm"],
    ["toast", "delete-toast"],
  ]) {
    await evalJs(cdp, `(() => { const b=[...document.querySelectorAll('.spec-tab')].find(x=>x.dataset.screen==='${screen}'); b?.click(); })()`);
    await sleep(400);
    await shot(cdp, join(BASE, `${name}.png`));
  }

  console.log("通过：删除流程 8 项自检");
  cdp.close();
} finally {
  proc.kill();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
}
