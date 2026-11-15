/**
 * 网格的数据源（04-项目计划 M2）。
 *
 * - Tauri 环境：`albumio_list` 只 readdir，`albumio_stat` 按 P0–P4 补 stat，
 *   `albumio_thumb` 取 L0/L1 缩略图字节。
 * - 浏览器环境（`npm run dev` / 无头截图）：用一份 42 项的假目录，缩略图是
 *   seeded 渐变的 data URL。假数据只用于对照设计稿的几何（列数/格宽/间距），
 *   不参与打包产物之外的行为，也不冒充真实文件。
 */

import { invoke } from "@tauri-apps/api/core";
import { desktopDir, downloadDir, homeDir, pictureDir } from "@tauri-apps/api/path";
import { StatScheduler, type Priority, type StatBatchResult, type StatRow } from "./scheduler";

export interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

export interface ListResult {
  generation: number;
  dir: string;
  entries: Entry[];
  elapsedMs: number;
}

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface LaunchTarget {
  /** 要打开的目录；路径不存在时为 null。 */
  dir: string | null;
  /** 要在看图里定位的文件（双击关联文件/拖入单个图片时）；目录目标为 null。 */
  file: string | null;
}

/** 启动目标：命令行传入的目录或文件；没有则回退到「图片」目录（M9）。 */
export async function launchTarget(): Promise<LaunchTarget> {
  if (!isTauri()) return { dir: "mock://图片/2024/京都", file: null };
  try {
    const t = await invoke<LaunchTarget>("albumio_launch_target");
    if (t.dir) return t;
    return { dir: await pictureDir(), file: null };
  } catch {
    return { dir: "", file: null };
  }
}

/** 拖放：把一个外部路径拆成「目录 + 可选文件」。 */
export async function resolveTarget(path: string): Promise<LaunchTarget> {
  if (!isTauri()) return { dir: "mock://图片/2024/京都", file: null };
  return invoke<LaunchTarget>("albumio_resolve_target", { path });
}

/** 是否以管理员身份运行（Windows 管理员进程收不到 Explorer 拖放，R13）。 */
export async function isElevated(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>("albumio_elevated");
  } catch {
    return false;
  }
}

export async function listDir(dir: string): Promise<ListResult> {
  if (!isTauri()) {
    const entries = mockEntries();
    return { generation: 1, dir, entries, elapsedMs: 0 };
  }
  return invoke<ListResult>("albumio_list", { dir });
}

export function createScheduler(): StatScheduler {
  if (!isTauri()) {
    return new StatScheduler(async (paths) => ({
      stats: paths.map((p) => {
        const i = Number(p.match(/(\d+)/)?.[1] ?? 0);
        return { path: p, size: 6_200_000 + i * 137_000, mtimeNs: 1_700_000_000_000_000_000 + i };
      }),
      cancelled: false,
    }));
  }
  return new StatScheduler(
    (paths, priority, generation) =>
      invoke<StatBatchResult>("albumio_stat", { paths, priority, generation })
  );
}

export const PRIORITY = {
  visible: 0 as Priority,
  prefetch: 1 as Priority,
  currentDir: 2 as Priority,
  neighbor: 3 as Priority,
  all: 4 as Priority,
};

/* ---------------- 缩略图 ---------------- */

const thumbCache = new Map<string, string>();
const THUMB_CACHE_MAX = 600;

function cachePut(key: string, url: string): string {
  if (thumbCache.size >= THUMB_CACHE_MAX) {
    // 只从索引里丢，不 revoke：同一个 URL 可能还在屏幕上（`releaseThumb` 才真正归还）。
    const oldest = thumbCache.keys().next().value;
    if (oldest) thumbCache.delete(oldest);
  }
  thumbCache.set(key, url);
  return url;
}

/** 归还一个不再显示的缩略图：缓存里还是同一个 URL 才删，然后撤销 blob。 */
export function releaseThumb(
  path: string,
  level: "l0" | "l1",
  url: string
): void {
  const key = `${path}|${level}`;
  if (thumbCache.get(key) === url) thumbCache.delete(key);
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

/** L0（32px）先上屏，L1（256px）补位；两级都缓存，重复滚回不重解码。 */
export async function thumbUrl(path: string, level: "l0" | "l1"): Promise<string> {
  const key = `${path}|${level}`;
  const hit = thumbCache.get(key);
  if (hit) return hit;

  if (!isTauri()) {
    return cachePut(key, mockThumb(path, level === "l0" ? 32 : 256));
  }
  const bytes = await invoke<ArrayBuffer>("albumio_thumb", { path, level });
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
  return cachePut(key, url);
}

/* ---------------- 全屏看图代理（M5） ---------------- */

// L2 是 2048px 代理，单张几百 KB，内存里只留当前 + 前后各一张，
// 翻页时旧图要能及时归还（`releasePreview`），不跟着 600 条的缩略图缓存混。
const previewCache = new Map<string, string>();
const PREVIEW_CACHE_MAX = 6;

function cachePreview(key: string, url: string): string {
  if (previewCache.size >= PREVIEW_CACHE_MAX) {
    // 与缩略图一样只丢索引，等 viewer 明确归还时再 revoke。
    const oldest = previewCache.keys().next().value;
    if (oldest) previewCache.delete(oldest);
  }
  previewCache.set(key, url);
  return url;
}

/** 归还全屏看图的 L2 代理（离开当前项 / 关闭 viewer 时调用）。 */
export function releasePreview(path: string, url: string): void {
  if (previewCache.get(path) === url) previewCache.delete(path);
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

/** 全屏看图的 L2 代理（长边 2048，与网格的 L1 分开缓存）。 */
export async function previewUrl(path: string): Promise<string> {
  const hit = previewCache.get(path);
  if (hit) return hit;
  if (!isTauri()) return cachePreview(path, mockPreview(path));
  const bytes = await invoke<ArrayBuffer>("albumio_thumb", { path, level: "l2" });
  const url = URL.createObjectURL(new Blob([bytes], { type: "image/webp" }));
  return cachePreview(path, url);
}

/* ---------------- 删除（§11.6） ---------------- */

export interface DeleteFailure {
  path: string;
  reason: string;
}

export interface DeleteOutcome {
  deleted: string[];
  failed: DeleteFailure[];
  canUndo: boolean;
  at: number;
}

/**
 * 删除。`permanent=false` 进系统回收站（可撤销），`true` 从磁盘删除。
 * 浏览器假数据下直接成功，不产生真实删除。
 */
export async function deletePaths(
  paths: string[],
  permanent: boolean
): Promise<DeleteOutcome> {
  if (!isTauri()) {
    return { deleted: paths, failed: [], canUndo: !permanent, at: 0 };
  }
  return invoke<DeleteOutcome>("albumio_delete", { paths, permanent });
}

/** 撤销「移到回收站」，`since` 用删除返回的 `at`。 */
export async function restorePaths(paths: string[], since: number): Promise<DeleteOutcome> {
  if (!isTauri()) {
    return { deleted: paths, failed: [], canUndo: true, at: 0 };
  }
  return invoke<DeleteOutcome>("albumio_restore", { paths, since });
}

/* ---------------- 侧栏与时间线（M3） ---------------- */

export interface NavRoot {
  name: string;
  path: string;
}

export interface SubDir {
  name: string;
  path: string;
  /** 直接子文件里的图片数（不递归）。 */
  images: number;
}

export interface DiskInfo {
  label: string;
  freeBytes: number;
  totalBytes: number;
}

export interface TakenRow {
  path: string;
  takenAt: number;
  takenAtText: string | null;
  source: "exif" | "xmp" | "inferred";
  failed: boolean;
}

/** 树的根：Windows 是盘符，Unix 是 `/` 与主目录。 */
export async function navRoots(): Promise<NavRoot[]> {
  if (!isTauri()) return [{ name: "图片", path: "mock://图片" }];
  return invoke<NavRoot[]>("albumio_roots");
}

/** 展开一层：只读直接子目录，带各自的直接图片数。 */
export async function subDirs(dir: string): Promise<SubDir[]> {
  if (!isTauri()) {
    if (dir === "mock://图片") {
      return [
        { name: "2024", path: "mock://图片/2024", images: 0 },
        { name: "2025", path: "mock://图片/2025", images: 12 },
      ];
    }
    if (dir === "mock://图片/2024") {
      return [{ name: "京都", path: "mock://图片/2024/京都", images: 42 }];
    }
    return [];
  }
  return invoke<SubDir[]>("albumio_dirs", { dir });
}

/** 侧栏底部的磁盘用量；取不到返回 null（网络盘、权限）。 */
export async function diskInfo(dir: string): Promise<DiskInfo | null> {
  if (!isTauri()) {
    return { label: "C:", freeBytes: 128 * 1024 ** 3, totalBytes: 512 * 1024 ** 3 };
  }
  try {
    return await invoke<DiskInfo | null>("albumio_disk", { dir });
  } catch {
    return null;
  }
}

/** 时间线分桶：只读拍摄时间，一批 250 条由调用方切。 */
export async function takenTimes(paths: string[]): Promise<TakenRow[]> {
  if (!isTauri()) {
    const base = Date.now();
    return paths.map((path, i) => ({
      path,
      takenAt: base - i * 36_000_000,
      takenAtText: null,
      source: i % 7 === 0 ? "inferred" : "exif",
      failed: false,
    }));
  }
  return invoke<TakenRow[]>("albumio_taken", { paths });
}

/** 快速访问：图片 / 桌面 / 下载 / 主目录，取不到的跳过。 */
export async function quickPlaces(): Promise<NavRoot[]> {
  if (!isTauri()) {
    return [
      { name: "图片", path: "mock://图片" },
      { name: "下载", path: "mock://下载" },
    ];
  }
  const probes: Array<[string, () => Promise<string>]> = [
    ["图片", pictureDir],
    ["桌面", desktopDir],
    ["下载", downloadDir],
    ["主目录", homeDir],
  ];
  const out: NavRoot[] = [];
  for (const [name, fn] of probes) {
    try {
      const p = await fn();
      if (p) out.push({ name, path: p });
    } catch {
      /* 某些系统目录不存在（如企业环境禁用了桌面），跳过 */
    }
  }
  return out;
}

/* ---------------- 浏览器假数据 ---------------- */

const MOCK_COUNT = 42;

function mockEntries(): Entry[] {
  return Array.from({ length: MOCK_COUNT }, (_, i) => {
    const ext = i % 11 === 0 ? "HEIC" : i % 17 === 5 ? "PNG" : "JPG";
    const name = `DSC_${String(482 + i).padStart(4, "0")}.${ext}`;
    return { name, path: `mock://图片/2024/京都/${name}`, isDir: false };
  });
}

const MOCK_PALETTES = [
  ["#241A3A", "#6E3A57", "#E19A6A"],
  ["#0D1A2C", "#254A6B", "#8FAEBE"],
  ["#16231C", "#37503F", "#A9BFAE"],
  ["#0A0F17", "#1B2838", "#46586F"],
  ["#3A2418", "#8A5533", "#E7B981"],
  ["#1A2531", "#5C7488", "#DCE6EE"],
  ["#26170F", "#6E3E22", "#D08A3C"],
  ["#141418", "#2E2E34", "#8C8C92"],
];

function mockThumb(path: string, size: number): string {
  const i = Number(path.match(/(\d+)/)?.[1] ?? 0);
  const [a, b, c] = MOCK_PALETTES[i % MOCK_PALETTES.length];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1">` +
    `<stop offset="0" stop-color="${a}"/><stop offset="0.62" stop-color="${b}"/>` +
    `<stop offset="1" stop-color="${c}"/></linearGradient></defs>` +
    `<rect width="${size}" height="${size}" fill="url(#g)"/>` +
    `<circle cx="${size * 0.68}" cy="${size * 0.3}" r="${size * 0.06}" fill="#FFE9C4" opacity="0.85"/>` +
    `<path d="M0 ${size * 0.72} L${size * 0.35} ${size * 0.52} L${size * 0.62} ${size * 0.74} ` +
    `L${size} ${size * 0.58} L${size} ${size} L0 ${size} Z" fill="${a}" opacity="0.92"/>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** 假数据的 L2 代理：3:2 横构图，长边 2048，与真机 L2 的尺寸关系一致。 */
function mockPreview(path: string): string {
  const i = Number(path.match(/(\d+)/)?.[1] ?? 0);
  const [a, b, c] = MOCK_PALETTES[i % MOCK_PALETTES.length];
  const w = 2048;
  const h = 1365;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="0.35" y2="1">` +
    `<stop offset="0" stop-color="${a}"/><stop offset="0.55" stop-color="${b}"/>` +
    `<stop offset="1" stop-color="${c}"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    `<circle cx="${w * 0.7}" cy="${h * 0.26}" r="${h * 0.05}" fill="#FFE9C4" opacity="0.85"/>` +
    `<path d="M0 ${h * 0.78} L${w * 0.3} ${h * 0.5} L${w * 0.55} ${h * 0.7} ` +
    `L${w * 0.78} ${h * 0.46} L${w} ${h * 0.62} L${w} ${h} L0 ${h} Z" fill="${a}" opacity="0.9"/>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export type { StatRow };
