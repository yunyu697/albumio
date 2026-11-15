/**
 * 非破坏性编辑的数据层（04-项目计划 M6）。
 *
 * 前端只持有"参数"，不碰像素：每次改动把编辑栈 JSON 发给后端，后端在 L2 代理上
 * 跑 `apply_ops` 回一张 WebP。预览与导出因此共用同一段实现（`01-方案文档.md` §5.2）。
 *
 * 操作顺序固定 orient → crop → 色彩 → 锐化；号数只为 UI 展示，不参与计算。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri, previewUrl } from "./source";

export type OpName =
  | "orient"
  | "crop"
  | "exposure"
  | "contrast"
  | "saturation"
  | "sharpen";

export type RatioId = "free" | "1:1" | "3:2" | "4:3" | "16:9";

export const RATIOS: RatioId[] = ["free", "1:1", "3:2", "4:3", "16:9"];

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EditState {
  /** 顺时针角度，0 / 90 / 180 / 270。 */
  orientDeg: number;
  orientFlip: boolean;
  cropRect: CropRect;
  cropAspect: RatioId;
  /** 裁剪框正在编辑（预览不应用裁剪，方便继续拉框）。 */
  cropEditing: boolean;
  /** 裁剪已被用户确认（Enter / 切走工具），才写入编辑栈。 */
  cropCommitted: boolean;
  /** -100..100，写入时换算成 EV = v / 100。 */
  exposure: number;
  contrast: number;
  saturation: number;
  /** 0..100，写入时换算成 0..1 的锐化量。 */
  sharpen: number;
  /** 被移除（停用）的步骤：仍显示在操作栈里，但不参与渲染与导出。 */
  disabled: OpName[];
}

export const FULL_RECT: CropRect = { x: 0, y: 0, w: 1, h: 1 };
/** 与设计稿的 `inset:12% 10%` 同值。 */
export const DEFAULT_RECT: CropRect = { x: 0.1, y: 0.12, w: 0.8, h: 0.76 };

export const EMPTY_STATE: EditState = {
  orientDeg: 0,
  orientFlip: false,
  cropRect: DEFAULT_RECT,
  cropAspect: "free",
  cropEditing: true,
  cropCommitted: false,
  exposure: 0,
  contrast: 0,
  saturation: 0,
  sharpen: 0,
  disabled: [],
};

export interface Op {
  op: OpName;
  deg?: number;
  flip?: boolean;
  rect?: [number, number, number, number];
  aspect?: RatioId;
  ev?: number;
  k?: number;
  amount?: number;
}

export interface EditStack {
  v: 1;
  ops: Op[];
}

export const isFullRect = (r: CropRect): boolean =>
  r.x <= 1e-6 && r.y <= 1e-6 && 1 - (r.x + r.w) <= 1e-6 && 1 - (r.y + r.h) <= 1e-6;

const on = (s: EditState, name: OpName): boolean => !s.disabled.includes(name);

/** 参数 → 编辑栈。中性值不产生操作（操作栈里也不该出现"曝光 0"这种行）。 */
export function toStack(s: EditState): EditStack {
  const ops: Op[] = [];
  if (on(s, "orient") && (s.orientDeg % 360 !== 0 || s.orientFlip)) {
    ops.push({ op: "orient", deg: ((s.orientDeg % 360) + 360) % 360, flip: s.orientFlip });
  }
  if (on(s, "crop") && s.cropCommitted && !isFullRect(s.cropRect)) {
    ops.push({
      op: "crop",
      rect: [s.cropRect.x, s.cropRect.y, s.cropRect.w, s.cropRect.h],
      aspect: s.cropAspect,
    });
  }
  if (on(s, "exposure") && s.exposure !== 0) {
    ops.push({ op: "exposure", ev: s.exposure / 100 });
  }
  if (on(s, "contrast") && s.contrast !== 0) {
    ops.push({ op: "contrast", k: s.contrast / 100 });
  }
  if (on(s, "saturation") && s.saturation !== 0) {
    ops.push({ op: "saturation", k: s.saturation / 100 });
  }
  if (on(s, "sharpen") && s.sharpen !== 0) {
    ops.push({ op: "sharpen", amount: s.sharpen / 100 });
  }
  return { v: 1, ops };
}

/** 编辑栈 → 参数。后端返回的顺序已经规范化，这里仍按 key 取值，不依赖顺序。 */
export function fromStack(ops: Op[] | undefined): EditState {
  // 没有裁剪记录时直接进裁剪工具（设计稿默认态）；已有裁剪则显示裁后结果。
  const s: EditState = { ...EMPTY_STATE, cropRect: { ...DEFAULT_RECT }, cropEditing: true };
  for (const op of ops ?? []) {
    switch (op.op) {
      case "orient":
        s.orientDeg = ((Math.round((op.deg ?? 0) / 90) * 90) % 360 + 360) % 360;
        s.orientFlip = !!op.flip;
        break;
      case "crop":
        if (op.rect) {
          s.cropRect = { x: op.rect[0], y: op.rect[1], w: op.rect[2], h: op.rect[3] };
          s.cropAspect = op.aspect ?? "free";
          s.cropCommitted = true;
          s.cropEditing = false;
        }
        break;
      case "exposure":
        s.exposure = Math.round((op.ev ?? 0) * 100);
        break;
      case "contrast":
      case "saturation":
        s[op.op === "contrast" ? "contrast" : "saturation"] = Math.round((op.k ?? 0) * 100);
        break;
      case "sharpen":
        s.sharpen = Math.round((op.amount ?? 0) * 100);
        break;
      default:
        break;
    }
  }
  return s;
}

/** 写入磁盘的是"启用且非中性"的栈；空栈 = 删除编辑记录。 */
export function stackJson(s: EditState): string {
  const stack = toStack(s);
  return stack.ops.length === 0 ? "" : JSON.stringify(stack);
}

export function opCount(s: EditState): number {
  return toStack(s).ops.length;
}

/* ---------------- 浏览器演示模式 ---------------- */

const mockStore = new Map<string, string>();
const mockFromStack = (path: string): EditStack | null => {
  const raw = mockStore.get(path);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as EditStack;
  } catch {
    return null;
  }
};

/* ---------------- 持久化 ---------------- */

export interface EditLoadResult {
  state: EditState;
  stale: boolean;
  source: "sidecar" | "index" | "none";
}

export async function loadEdits(path: string): Promise<EditLoadResult> {
  if (!isTauri()) {
    const stack = mockFromStack(path);
    return {
      state: fromStack(stack?.ops),
      stale: false,
      source: stack ? "sidecar" : "none",
    };
  }
  const r = await invoke<{
    ops: string;
    stale: boolean;
    source: "sidecar" | "index" | "none";
  }>("albumio_edits_load", { path });
  let ops: Op[] = [];
  if (r.ops) {
    try {
      ops = (JSON.parse(r.ops) as EditStack).ops ?? [];
    } catch {
      ops = [];
    }
  }
  return {
    state: fromStack(ops),
    stale: r.stale,
    // 从网格再打开时，首次没有裁剪记录也不强行进入裁剪工具。
    source: r.source,
  };
}

export interface SaveResult {
  saved: boolean;
  warnings: string[];
}

export async function saveEdits(path: string, s: EditState): Promise<SaveResult> {
  const json = stackJson(s);
  if (!isTauri()) {
    if (json) mockStore.set(path, json);
    else mockStore.delete(path);
    return { saved: true, warnings: [] };
  }
  return invoke<SaveResult>("albumio_edits_save", { path, ops: json });
}

/* ---------------- 预览 ---------------- */

export interface PreviewResult {
  /** 预览图 URL；`revoke` 必须由调用方在换图/关闭时执行。 */
  url: string;
  revoke: () => void;
  /** 演示模式：后端不在，颜色用 CSS 滤镜近似，不代表真实管线。 */
  mockFilter?: string;
}

export async function editPreview(path: string, s: EditState): Promise<PreviewResult> {
  // 裁剪框编辑期间不应用裁剪，否则用户只能在"已裁掉"的图上继续拉框。
  const stack = toStack({ ...s, cropCommitted: s.cropCommitted && !s.cropEditing });
  if (!isTauri()) {
    const url = await previewUrl(path);
    return { url, revoke: () => {}, mockFilter: mockFilter(s) };
  }
  const bytes = await invoke<ArrayBuffer>("albumio_edit_preview", {
    path,
    ops: JSON.stringify(stack),
  });
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

function mockFilter(s: EditState): string {
  const bright = Math.pow(2, s.exposure / 100);
  const contrast = 1 + s.contrast / 100;
  const saturate = 1 + s.saturation / 100;
  return `brightness(${bright.toFixed(3)}) contrast(${contrast.toFixed(3)}) saturate(${saturate.toFixed(3)})`;
}

/* ---------------- 导出 ---------------- */

export interface ExportInfo {
  path: string;
  width: number;
  height: number;
  bytes: number;
  /** 演示模式没有真正写盘，只能用于对照界面。 */
  mock?: boolean;
}

export async function exportEdits(path: string, s: EditState): Promise<ExportInfo> {
  if (!isTauri()) {
    const stem = path.replace(/\.[^.\\/]+$/, "");
    return {
      path: `${stem}_Albumio.jpg`,
      width: 0,
      height: 0,
      bytes: 0,
      mock: true,
    };
  }
  return invoke<ExportInfo>("albumio_edit_export", {
    path,
    ops: JSON.stringify(toStack(s)),
  });
}

/** 供撤销/还原用的深拷贝（状态只有一层嵌套）。 */
export function cloneState(s: EditState): EditState {
  return { ...s, cropRect: { ...s.cropRect }, disabled: [...s.disabled] };
}

/** 两张参数表是否等价（滑杆拖动结束判断是否需要记一步撤销）。 */
export function sameState(a: EditState, b: EditState): boolean {
  return JSON.stringify(toStack(a)) === JSON.stringify(toStack(b)) &&
    a.disabled.join() === b.disabled.join();
}
