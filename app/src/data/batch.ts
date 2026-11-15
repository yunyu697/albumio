/**
 * 批量处理的数据源（04-项目计划 M7 / 屏 4）。
 *
 * - Tauri：`albumio_batch_plan` 规划输出名与尺寸，`albumio_batch_run` 逐条执行，
 *   每条结果从 `albumio://batch-progress` 事件回来；`albumio_batch_cancel` 只置取消位。
 * - 浏览器（`npm run dev` / 无头对照）：用与 Rust 同规则的前端实现模拟 12 项队列，
 *   第 4 条跳过、第 9 条失败，用于验证三态与失败清单的几何。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "./source.ts";
import {
  expandPattern,
  join,
  resizeDims,
  sanitizeName,
  uniqueName,
  type ResizeMode,
} from "./batch-naming.ts";

export type { ResizeMode };
export type BatchFormat = "keep" | "jpeg" | "png" | "webp";

export interface BatchSourceInput {
  path: string;
  name: string;
  width: number;
  height: number;
  size: number;
  /** 模板占位符用的本地时区值，缺失时后端回退 EXIF。 */
  camera: string;
  date: string;
  time: string;
}

export interface BatchOptions {
  outDir: string;
  rename: boolean;
  pattern: string;
  convert: boolean;
  format: BatchFormat;
  quality: number;
  resize: ResizeMode;
}

export interface BatchPlanItem {
  src: string;
  name: string;
  out: string;
  outName: string;
  format: "jpeg" | "png" | "webp";
  sourceFormat: string;
  width: number;
  height: number;
  quality: number;
  conflict: boolean;
  skip: string | null;
  estBytes: number;
}

export interface BatchPlan {
  items: BatchPlanItem[];
  outDir: string;
  total: number;
  conflicts: number;
  skipped: number;
  estBytes: number;
  summary: string;
}

export type BatchItemStatus = "done" | "skipped" | "failed";

export interface BatchItemResult {
  src: string;
  out: string | null;
  status: BatchItemStatus;
  reason: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  format: string | null;
}

export interface BatchOutcome {
  cancelled: boolean;
  results: BatchItemResult[];
}

export interface BatchProgress {
  index: number;
  total: number;
  phase: "begin" | "item";
  result?: BatchItemResult;
}

/* ---------------- Tauri ---------------- */

export async function planBatch(
  sources: BatchSourceInput[],
  options: BatchOptions
): Promise<BatchPlan> {
  if (!isTauri()) return mockPlan(sources, options);
  return invoke<BatchPlan>("albumio_batch_plan", { sources, options });
}

export async function runBatch(
  items: BatchPlanItem[],
  onProgress: (p: BatchProgress) => void
): Promise<BatchOutcome> {
  if (!isTauri()) return mockRun(items, onProgress);
  const unlisten = await listen<BatchProgress>("albumio://batch-progress", (e) =>
    onProgress(e.payload)
  );
  try {
    return await invoke<BatchOutcome>("albumio_batch_run", { items });
  } finally {
    unlisten();
  }
}

export async function cancelBatch(): Promise<void> {
  if (!isTauri()) {
    mockCancelled = true;
    return;
  }
  await invoke("albumio_batch_cancel");
}

/* ---------------- 浏览器模拟 ---------------- */

const EXT: Record<"jpeg" | "png" | "webp", string> = { jpeg: "jpg", png: "png", webp: "webp" };
const LABEL: Record<"jpeg" | "png" | "webp", string> = {
  jpeg: "JPEG",
  png: "PNG",
  webp: "WebP",
};
const RESIZE_LABEL: Record<ResizeMode, string> = {
  none: "原尺寸",
  long2048: "长边 2048",
  long1280: "长边 1280",
  percent50: "50%",
};

function keepFormat(name: string): "jpeg" | "png" | "webp" {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "png";
  if (ext === "webp") return "webp";
  return "jpeg";
}

// 模拟用的固定失败/跳过项：按 src 记住，暂停续跑不会重复触发，重试后变成功。
let mockSkipSrc: string | null = null;
let mockFailSrc: string | null = null;
let mockSkipDone = false;
let mockFailDone = false;

function mockPlan(sources: BatchSourceInput[], o: BatchOptions): BatchPlan {
  const taken = new Set<string>();
  const total = sources.length;
  const seqWidth = Math.max(2, String(Math.max(1, total)).length);
  const items: BatchPlanItem[] = [];
  let conflicts = 0;
  let estBytes = 0;

  sources.forEach((s, i) => {
    const sourceFormat = keepFormat(s.name);
    const format =
      o.convert && o.format !== "keep" ? (o.format as "jpeg" | "png" | "webp") : sourceFormat;
    const sw = s.width || 6000;
    const sh = s.height || 4000;
    const { width, height } = resizeDims(sw, sh, o.resize);
    const stem = s.name.replace(/\.[^.]+$/, "");
    const renamed = o.rename
      ? sanitizeName(
          expandPattern(o.pattern, {
            日期: s.date || "20240512",
            时间: s.time || "083107",
            序号: String(i + 1).padStart(seqWidth, "0"),
            原名: stem,
            相机: s.camera || "Sony A7M4",
            宽: sw,
            高: sh,
          })
        )
      : "";
    const base = renamed || stem;
    const { name, conflict } = uniqueName(o.outDir, base, EXT[format], taken);
    if (conflict) conflicts++;
    const bytes = Math.max(1024, Math.round(width * height * (format === "png" ? 1.5 : 0.42)));
    estBytes += bytes;
    items.push({
      src: s.path,
      name: s.name,
      out: join(o.outDir, name),
      outName: name,
      format,
      sourceFormat,
      width,
      height,
      quality: o.quality,
      conflict,
      skip: null,
      estBytes: bytes,
    });
  });

  if (items.length > 10) {
    mockSkipSrc = items[3]?.src ?? null;
    mockFailSrc = items[8]?.src ?? null;
    mockSkipDone = false;
    mockFailDone = false;
  }

  const formats = new Set(items.map((i) => LABEL[i.format]));
  const fmtLabel = formats.size === 1 ? [...formats][0] : "混合格式";
  return {
    items,
    outDir: o.outDir,
    total,
    conflicts,
    skipped: 0,
    estBytes,
    summary: `${total} 个文件 · ${fmtLabel} · ${RESIZE_LABEL[o.resize]}`,
  };
}

let mockCancelled = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mockRun(
  items: BatchPlanItem[],
  onProgress: (p: BatchProgress) => void
): Promise<BatchOutcome> {
  mockCancelled = false;
  const results: BatchItemResult[] = [];
  for (let i = 0; i < items.length; i++) {
    if (mockCancelled) return { cancelled: true, results };
    const item = items[i];
    onProgress({ index: i, total: items.length, phase: "begin" });
    await sleep(170);
    if (mockCancelled) return { cancelled: true, results };
    const mockSkip = !item.skip && item.src === mockSkipSrc && !mockSkipDone;
    const mockFail = !mockSkip && item.src === mockFailSrc && !mockFailDone;
    if (mockSkip) mockSkipDone = true;
    if (mockFail) mockFailDone = true;
    const status: BatchItemStatus = item.skip || mockSkip ? "skipped" : mockFail ? "failed" : "done";
    results.push({
      src: item.src,
      out: status === "done" ? item.out : null,
      status,
      reason:
        status === "skipped"
          ? item.skip || "同名文件已存在，按设置跳过"
          : status === "failed"
            ? "源文件不可读（0x80070003）"
            : null,
      width: status === "done" ? item.width : null,
      height: status === "done" ? item.height : null,
      bytes: status === "done" ? item.estBytes : null,
      format: status === "done" ? item.format : null,
    });
    onProgress({ index: i, total: items.length, phase: "item", result: results[results.length - 1] });
  }
  return { cancelled: false, results };
}
