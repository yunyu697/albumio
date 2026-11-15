/**
 * M8 屏 1 目录监听的可复跑自检（04-项目计划 M8；`docs/spike/S6.md`）。
 *
 * 用法（先 `cd app && npm run build && npm run preview -- --port 4173`）：
 *   URL=http://127.0.0.1:4173/ node scripts/m8-check.mjs
 *
 * 浏览器假数据不会自己造事件：脚本通过 `window.__albumioWatchEmit` 投递
 * 与后端 `DirChanges` 同形的批次，验证前端增量合并的行为：
 * - 改名后选中/当前项跟着迁移，滚动位置不变；
 * - 删除后网格移除、不残留灰块；
 * - 新建按自然序插入；
 * - 外部变更 1 s 内反映到网格；
 * - 溢出（overflow）给出非模态提示并整目录重建。
 *
 * 产出：app/docs/acceptance/m8-listening.png、m8-renamed.png、m8-deleted.png、m8-overflow.png。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = Number(process.env.PORT ?? 9360);
const URL = process.env.URL ?? "";
const ROOT = resolve(import.meta.dirname, "..");
const ACC = join(ROOT, "app/docs/acceptance");
const profile = mkdtempSync(join(tmpdir(), "albumio-m8-"));

if (!URL) {
  console.error("请用 URL=http://127.0.0.1:4173/ 指定已构建的预览地址");
  process.exit(2);
}

const DIR = "mock://图片/2024/京都";
const path = (name) => `${DIR}/${name}`;
const RENAMED_FROM = "DSC_0490.JPG";
// 新名字仍排在同一格（0490 与 0491 之间），这样能区分"网格被重置"与
// "当前项移动后 Grid 主动跟随"这两种滚动变化。
const RENAMED_TO = "DSC_0490B.JPG";
const DELETED = "DSC_0486.JPG";
const CREATED = "DSC_0901.JPG";

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

async function shot(cdp, pathName) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(pathName, Buffer.from(s.result.data, "base64"));
}

const SNAP = `(() => {
  const stage = document.querySelector('.stage');
  const tiles = [...document.querySelectorAll('.tile')];
  const cap = (t) => t.querySelector('.tile-cap')?.textContent?.trim() ?? '';
  return {
    count: tiles.length,
    caps: tiles.map(cap),
    selected: tiles.filter((t) => t.classList.contains('sel')).map(cap),
    current: tiles.filter((t) => t.classList.contains('cur')).map(cap),
    scroll: stage ? stage.scrollTop : -1,
    toast: document.querySelector('.toast')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
    uniqueCaps: new Set(tiles.map(cap)).size,
  };
})()`;

const emit = (changes) =>
  `(() => {
    const fn = window.__albumioWatchEmit;
    if (!fn) return false;
    fn(${JSON.stringify(changes)});
    return true;
  })()`;

const clickTile = (name) =>
  `(() => {
    const t = [...document.querySelectorAll('.tile')].find(
      (el) => (el.querySelector('.tile-cap')?.textContent ?? '').trim() === ${JSON.stringify(name)}
    );
    if (!t) return false;
    t.click();
    return true;
  })()`;

async function waitFor(cdp, expr, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    const ok = await evalJs(cdp, expr);
    if (ok) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
    await sleep(30);
  }
}

const CHECKS = [];
function check(cond, label) {
  if (!cond) throw new Error(`断言失败：${label}`);
  CHECKS.push(label);
}

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
  await sleep(2200);

  let s = await evalJs(cdp, SNAP);
  console.log("1 初始", { count: s.count, toast: s.toast });
  check(s.count === 42, "初始 42 个格子");
  check(s.uniqueCaps === s.count, "初始没有重名格子");
  check(s.toast === null, "监听生效时不出现额外提示（G3 无视觉变化）");
  await shot(cdp, join(ACC, "m8-listening.png"));

  // 选中第 9 张，作为改名迁移的观察点。
  check(await evalJs(cdp, clickTile(RENAMED_FROM)), `点选 ${RENAMED_FROM}`);
  await evalJs(cdp, `document.querySelector('.stage').scrollTop = 240`);
  await sleep(250);
  s = await evalJs(cdp, SNAP);
  const scrollBefore = s.scroll;
  check(s.selected.length === 1 && s.selected[0] === RENAMED_FROM, "选中项正确");
  console.log("   选中后滚动位置", scrollBefore);

  /* 2. 外部改名：选中跟着迁移，滚动不跳 */
  const nowNs = Date.now() * 1e6;
  let elapsed = await (async () => {
    const t0 = Date.now();
    const ok = await evalJs(
      cdp,
      emit({
        dir: DIR,
        upserts: [{ path: path(RENAMED_TO), name: RENAMED_TO, size: 7_200_000, mtimeNs: nowNs }],
        removed: [path(RENAMED_FROM)],
        renamed: [{ from: path(RENAMED_FROM), to: path(RENAMED_TO) }],
        overflow: false,
      })
    );
    check(ok, "改名批次已投递");
    await waitFor(cdp, `document.body.textContent.includes(${JSON.stringify(RENAMED_TO)})`, 1000, "改名上屏");
    return Date.now() - t0;
  })();
  s = await evalJs(cdp, SNAP);
  console.log("2 改名", { elapsed, selected: s.selected, scroll: s.scroll });
  check(elapsed < 1000, `改名 1 s 内上屏（实测 ${elapsed} ms）`);
  check(s.count === 42, "改名不改变格子数");
  check(s.selected.length === 1 && s.selected[0] === RENAMED_TO, "选中迁移到新名字");
  check(s.current.includes(RENAMED_TO), "当前项迁移到新名字");
  check(s.scroll === scrollBefore, "改名不跳滚动位置");
  check(!s.caps.includes(RENAMED_FROM), "旧名字消失");
  await shot(cdp, join(ACC, "m8-renamed.png"));

  /* 3. 外部删除：移除且不留灰块 */
  elapsed = await (async () => {
    const t0 = Date.now();
    check(
      await evalJs(
        cdp,
        emit({ dir: DIR, upserts: [], removed: [path(DELETED)], renamed: [], overflow: false })
      ),
      "删除批次已投递"
    );
    await waitFor(
      cdp,
      `![...document.querySelectorAll('.tile-cap')].some((e) => e.textContent.trim() === ${JSON.stringify(DELETED)})`,
      1000,
      "删除生效"
    );
    return Date.now() - t0;
  })();
  s = await evalJs(cdp, SNAP);
  console.log("3 删除", { elapsed, count: s.count, selected: s.selected });
  check(elapsed < 1000, `删除 1 s 内上屏（实测 ${elapsed} ms）`);
  check(s.count === 41, "删除后少一个格子");
  check(s.uniqueCaps === s.count, "删除后没有残留灰块/重名");
  check(s.selected[0] === RENAMED_TO, "删除非选中项不影响选中");
  check(s.scroll === scrollBefore, "删除不跳滚动位置");
  await shot(cdp, join(ACC, "m8-deleted.png"));

  /* 4. 外部新建：按自然序插入 */
  elapsed = await (async () => {
    const t0 = Date.now();
    check(
      await evalJs(
        cdp,
        emit({
          dir: DIR,
          upserts: [{ path: path(CREATED), name: CREATED, size: 6_500_000, mtimeNs: nowNs }],
          removed: [],
          renamed: [],
          overflow: false,
        })
      ),
      "新建批次已投递"
    );
    await waitFor(cdp, `document.body.textContent.includes(${JSON.stringify(CREATED)})`, 1000, "新建上屏");
    return Date.now() - t0;
  })();
  s = await evalJs(cdp, SNAP);
  console.log("4 新建", { elapsed, count: s.count, tail: s.caps.slice(-3) });
  check(elapsed < 1000, `新建 1 s 内上屏（实测 ${elapsed} ms）`);
  check(s.count === 42, "新建后格子数恢复");
  check(s.caps.indexOf(CREATED) === s.count - 1, "新建按自然序排在末尾");

  /* 5. 溢出：提示 + 整目录重建 */
  check(
    await evalJs(cdp, emit({ dir: DIR, upserts: [], removed: [], renamed: [], overflow: true })),
    "溢出批次已投递"
  );
  await waitFor(
    cdp,
    `!!document.querySelector('.toast') && document.querySelector('.toast').textContent.includes('目录变化可能未全部捕获')`,
    1500,
    "溢出提示出现"
  );
  s = await evalJs(cdp, SNAP);
  console.log("5 溢出", { toast: s.toast, count: s.count, restored: s.caps.includes(RENAMED_FROM) });
  check(s.toast.includes("已自动刷新"), "溢出提示文案完整");
  check(s.count === 42 && s.caps.includes(RENAMED_FROM), "溢出后整目录重建恢复原列表");
  await shot(cdp, join(ACC, "m8-overflow.png"));

  cdp.close();
  console.log(`\nM8 自检通过（${CHECKS.length} 项）：改名/删除/新建增量、1s 内跟随、选中与滚动保持、溢出提示与重建`);
} finally {
  proc.kill();
}
