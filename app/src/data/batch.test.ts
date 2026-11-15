// @ts-nocheck -- 只在 node --test 下运行，不参与打包；避免为测试引入 @types/node。
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandPattern, join, resizeDims, sanitizeName, uniqueName } from "./batch-naming.ts";

test("模板占位符全部展开", () => {
  const out = expandPattern("{日期}_{时间}_{序号}_{原名}_{相机}_{宽}x{高}", {
    日期: "20240512",
    时间: "083107",
    序号: "007",
    原名: "DSC_0482",
    相机: "Sony A7M4",
    宽: 6000,
    高: 4000,
  });
  assert.equal(out, "20240512_083107_007_DSC_0482_Sony A7M4_6000x4000");
});

test("未知占位符原样保留", () => {
  assert.equal(expandPattern("{原名}_{未知}", { 原名: "a" }), "a_{未知}");
});

test("文件名清洗对齐 Windows 约束", () => {
  assert.equal(sanitizeName("a:b*c?. "), "a_b_c_");
  assert.equal(sanitizeName(" 京都 "), "京都");
});

test("同名追加 _1 且大小写不敏感", () => {
  const taken = new Set<string>();
  const dir = "D:\\图片\\导出";
  assert.deepEqual(uniqueName(dir, "京都", "jpg", taken), { name: "京都.jpg", conflict: false });
  assert.deepEqual(uniqueName(dir, "京都", "jpg", taken), { name: "京都_1.jpg", conflict: true });
  assert.deepEqual(uniqueName(dir, "京都", "JPG", taken), { name: "京都_2.JPG", conflict: true });
});

test("尺寸只缩不放", () => {
  assert.deepEqual(resizeDims(1000, 800, "long2048"), { width: 1000, height: 800 });
  assert.deepEqual(resizeDims(4000, 3000, "long2048"), { width: 2048, height: 1536 });
  assert.deepEqual(resizeDims(101, 51, "percent50"), { width: 51, height: 26 });
});

test("路径拼接按分隔符选择", () => {
  assert.equal(join("D:\\图片\\2024", "a.jpg"), "D:\\图片\\2024\\a.jpg");
  assert.equal(join("mock://图片/2024", "a.jpg"), "mock://图片/2024/a.jpg");
});
