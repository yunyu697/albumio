// @ts-nocheck -- 只在 node --test 下运行，不参与打包；避免为测试引入 @types/node。
import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketize, flatten } from "./timeline.ts";

const entry = (name: string) => ({
  name,
  path: `mock://${name}`,
  isDir: false,
});

const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

test("跨年跨月分桶正确，空桶不出现", () => {
  // 2026-11-18 是周三：本周从 11-16 起，本月从 11-01 起。
  const now = at(2026, 11, 18);
  const entries = [
    entry("today.jpg"),
    entry("yesterday.jpg"),
    entry("thisweek.jpg"),
    entry("thismonth.jpg"),
    entry("oct.jpg"),
    entry("lastyear.jpg"),
  ];
  const taken = new Map([
    [entries[0].path, { takenAt: at(2026, 11, 18, 9), inferred: false }],
    [entries[1].path, { takenAt: at(2026, 11, 17, 22), inferred: false }],
    [entries[2].path, { takenAt: at(2026, 11, 16, 8), inferred: false }],
    [entries[3].path, { takenAt: at(2026, 11, 3), inferred: false }],
    [entries[4].path, { takenAt: at(2026, 10, 20), inferred: false }],
    [entries[5].path, { takenAt: at(2025, 12, 31), inferred: false }],
  ]);

  const buckets = bucketize(entries, taken, now);
  assert.deepEqual(
    buckets.map((b) => b.label),
    ["今天", "昨天", "本周", "本月", "2026 年 10 月", "2025 年 12 月"]
  );
  assert.deepEqual(
    buckets.map((b) => b.items.length),
    [1, 1, 1, 1, 1, 1]
  );
  assert.equal(flatten(buckets).length, entries.length);
});

test("没有条目的桶不生成", () => {
  const now = at(2026, 11, 18);
  const entries = [entry("old.jpg")];
  const taken = new Map([[entries[0].path, { takenAt: at(2020, 1, 1), inferred: false }]]);
  const buckets = bucketize(entries, taken, now);
  assert.deepEqual(
    buckets.map((b) => b.label),
    ["2020 年 1 月"]
  );
});

test("推断条目排在组内末尾，并计入推断数", () => {
  const now = at(2026, 11, 18);
  const entries = [entry("inferred.jpg"), entry("real.jpg")];
  const taken = new Map([
    // 推断值时间更新，但仍必须排在真实拍摄时间之后
    [entries[0].path, { takenAt: at(2026, 11, 18, 23), inferred: true }],
    [entries[1].path, { takenAt: at(2026, 11, 18, 6), inferred: false }],
  ]);
  const buckets = bucketize(entries, taken, now);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].label, "今天");
  assert.equal(buckets[0].inferred, 1);
  assert.deepEqual(
    buckets[0].items.map((i) => i.entry.name),
    ["real.jpg", "inferred.jpg"]
  );
});

test("本周跨到上月时，上月条目进「本周」而不是「本月」", () => {
  // 2026-11-01 是周日：本周从 10-26（周一）起，本月从 11-01 起。
  const now = at(2026, 11, 1);
  const entries = [entry("oct30.jpg"), entry("oct20.jpg")];
  const taken = new Map([
    [entries[0].path, { takenAt: at(2026, 10, 30), inferred: false }],
    [entries[1].path, { takenAt: at(2026, 10, 20), inferred: false }],
  ]);
  const buckets = bucketize(entries, taken, now);
  assert.deepEqual(
    buckets.map((b) => b.label),
    ["本周", "2026 年 10 月"]
  );
});
