/**
 * S5 先行验证的运行器（`app/docs/spike/S5.md`）。
 *
 * 用 CDP 驱动无头 Edge 打开 `s5-scroll.html`，执行页面里的 rAF 滚动基准并把结果打回终端。
 * 之所以不用 `--dump-dom`：无头模式下不请求截图就没有合成帧，rAF 不会推进。
 *
 * 用法：node scripts/spike-s5-scroll.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PAGE = resolve(import.meta.dirname, "../app/docs/spike/s5-scroll.html");
const PORT = Number(process.env.S5_PORT ?? 9337);
const HTTP_PORT = Number(process.env.S5_HTTP_PORT ?? 8877);
const profile = mkdtempSync(join(tmpdir(), "albumio-s5-"));

/* 无头 Edge 拒绝 CDP 导航到 file://（会落到 chrome-error），改用本地 http 伺服。 */
const server = createServer((req, res) => {
  try {
    const body = readFileSync(PAGE);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${HTTP_PORT}/s5-scroll.html`;

const proc = spawn(EDGE, [
  "--headless=new",
  "--disable-gpu",
  "--force-device-scale-factor=1",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const events = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method && events.has(msg.method)) {
      events.get(msg.method)(msg.params);
    }
  });
  const ready = new Promise((r, j) => {
    ws.addEventListener("open", r);
    ws.addEventListener("error", j);
  });
  return {
    ready,
    on(method, fn) {
      events.set(method, fn);
    },
    send(method, params = {}) {
      return new Promise((res) => {
        const n = ++id;
        pending.set(n, res);
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

try {
  const target = await findTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  cdp.on("Runtime.exceptionThrown", (p) => {
    console.error("页面异常：", p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text);
  });
  // 无头模式只在有合成帧请求时推进 rAF；开一个低质量 screencast 当"帧泵"，
  // 每帧立刻 ack，避免 CDP 背压。滚动基准因此才跑得起来。
  cdp.on("Page.screencastFrame", (p) => cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }));
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 10, maxWidth: 1200, maxHeight: 700 });
  await cdp.send("Page.navigate", { url: pageUrl });
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(250);
    const probe = await cdp.send("Runtime.evaluate", {
      expression: "typeof window.__runBench",
      returnByValue: true,
    });
    ready = probe.result?.result?.value === "function";
  }
  if (!ready) {
    const dbg = await cdp.send("Runtime.evaluate", {
      expression: "JSON.stringify({href: location.href, state: document.readyState, rows: document.querySelectorAll('.row').length, out: document.getElementById('out')?.textContent})",
      returnByValue: true,
    });
    throw new Error("页面脚本未就绪（__runBench 不存在）：" + dbg.result?.result?.value);
  }
  const r = await Promise.race([
    cdp.send("Runtime.evaluate", {
      expression: "window.__runBench()",
      awaitPromise: true,
      returnByValue: true,
    }),
    sleep(90000).then(() => {
      throw new Error("基准 90s 未返回（rAF 未推进？）");
    }),
  ]);
  if (r.result?.exceptionDetails) {
    throw new Error(JSON.stringify(r.result.exceptionDetails));
  }
  console.log(JSON.stringify(r.result.result.value, null, 2));
  cdp.close();
} finally {
  proc.kill();
  server.close();
  setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
}
