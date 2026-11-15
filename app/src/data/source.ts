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
import { pictureDir } from "@tauri-apps/api/path";
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

export async function defaultDir(): Promise<string> {
  if (!isTauri()) return "mock://图片/2024/京都";
  try {
    const start = await invoke<string | null>("albumio_start_dir");
    if (start) return start;
    return await pictureDir();
  } catch {
    return "";
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

export type { StatRow };
