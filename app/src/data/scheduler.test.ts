// @ts-nocheck -- 只在 node --test 下运行，不参与打包；避免为测试引入 @types/node。
import { test } from "node:test";
import assert from "node:assert/strict";
import { StatScheduler } from "./scheduler.ts";

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("P0 先于 P1/P2 出队，同优先级 FIFO", async () => {
  const calls: number[] = [];
  const gates: ReturnType<typeof deferred>[] = [];
  const s = new StatScheduler(async (paths, priority) => {
    calls.push(priority);
    const gate = deferred();
    gates.push(gate);
    return gate.promise;
  });

  const order: string[] = [];
  const mk = (name: string, p: 0 | 1 | 2) =>
    s.request([name], p).then(() => order.push(name));

  const a = mk("p2", 2);
  const b = mk("p0a", 0);
  const c = mk("p1", 1);
  const d = mk("p0b", 0);

  await flush();
  assert.deepEqual(calls, [2], "第一批立刻起飞");

  gates[0].resolve({ stats: [], cancelled: false });
  await flush();
  assert.equal(calls[1], 0, "P0 插到 P1/P2 前面");

  gates[1].resolve({ stats: [], cancelled: false });
  await flush();
  assert.equal(calls[2], 0, "同优先级 FIFO：先入队的 p0a");

  gates[2].resolve({ stats: [], cancelled: false });
  await flush();
  assert.equal(calls[3], 1);

  gates[3].resolve({ stats: [], cancelled: false });
  await Promise.all([a, b, c, d]);
  assert.deepEqual(order, ["p2", "p0a", "p0b", "p1"]);
});

test("generation 变化后排队任务立即作废，不发起请求", async () => {
  const calls: string[][] = [];
  let release: (v: any) => void = () => {};
  const s = new StatScheduler((paths) => {
    calls.push(paths);
    return new Promise((r) => (release = r));
  });

  const first = s.request(["a"], 0);
  await flush();
  const queued = s.request(["b"], 2);
  s.setGeneration(7);
  const r = await queued;
  assert.equal(r.cancelled, true);
  assert.equal(s.pendingCount, 0);

  release({ stats: [{ path: "a", size: 1, mtimeNs: 2 }], cancelled: false });
  const firstResult = await first;
  assert.equal(firstResult.cancelled, true, "在飞结果也必须按 generation 丢弃");
  assert.deepEqual(calls, [["a"]], "旧 generation 的排队任务不得发起请求");
});

test("换 generation 后新请求按新 generation 正常执行", async () => {
  const seen: number[] = [];
  const s = new StatScheduler(async (_paths, _p, gen) => {
    seen.push(gen);
    return { stats: [], cancelled: false };
  });
  s.setGeneration(3);
  await s.request(["x"], 0);
  s.setGeneration(4);
  await s.request(["y"], 0);
  assert.deepEqual(seen, [3, 4]);
});

test("空路径不发请求", async () => {
  let n = 0;
  const s = new StatScheduler(async () => {
    n++;
    return { stats: [], cancelled: false };
  });
  const r = await s.request([], 0);
  assert.equal(n, 0);
  assert.equal(r.cancelled, false);
});
