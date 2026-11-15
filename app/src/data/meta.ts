/**
 * 检查器的数据源（04-项目计划 M4）。
 *
 * - Tauri：`albumio_meta` 返回 EXIF/XMP 的 MWG 合并结果与直方图。
 * - 浏览器（`npm run dev` / 无头截图）：按路径种子生成一份与设计稿数值一致的
 *   假数据，只用于 G3 逐屏对照，不冒充真实文件。
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./source";

export type MetaSource = "exif" | "xmp" | "inferred";

export interface Histogram {
  bins: number;
  r: number[];
  g: number[];
  b: number[];
  pixels: number;
}

export interface PhotoMeta {
  path: string;
  name: string;
  format: string;
  width: number | null;
  height: number | null;
  size: number;
  mtimeNs: number;
  takenAt: number;
  takenAtText: string | null;
  takenSource: MetaSource | null;
  title: string | null;
  titleSource: MetaSource | null;
  keywords: string[];
  keywordsSource: MetaSource | null;
  rights: string | null;
  rightsSource: MetaSource | null;
  rating: number | null;
  ratingSource: MetaSource | null;
  camera: string | null;
  lens: string | null;
  exposure: string | null;
  iso: number | null;
  focal: number | null;
  orientation: number;
  orientationSource: MetaSource | null;
  gps: { lat: number; lon: number } | null;
  icc: string | null;
  histogram: Histogram;
}

export async function loadMeta(path: string): Promise<PhotoMeta> {
  if (!isTauri()) return mockMeta(path);
  return invoke<PhotoMeta>("albumio_meta", { path });
}

/* ---------------- 浏览器假数据 ---------------- */

function seedOf(path: string): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function rnd(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function mockMeta(path: string): PhotoMeta {
  const seed = seedOf(path);
  const rand = rnd(seed);
  const name = path.split("/").pop() ?? "DSC_0482.JPG";
  const ext = (name.split(".").pop() ?? "JPG").toUpperCase();
  // 每 7 张放一张没有拍摄时间的样本，用来在演示环境里看「推断」标记。
  const inferred = seed % 7 === 0;
  const takenText = "2024-11-03 16:20";
  const takenAt = Date.UTC(2024, 10, 3, 16, 20);
  const base = 6_200_000 + (seed % 5_000_000);

  return {
    path,
    name,
    format: ext.toLowerCase(),
    width: 6000,
    height: 4000,
    size: base,
    mtimeNs: (takenAt + 3_600_000) * 1e6,
    takenAt: inferred ? Date.UTC(2024, 10, 3, 17, 20) : takenAt,
    takenAtText: inferred ? null : takenText,
    takenSource: inferred ? "inferred" : "exif",
    title: "京都夜行",
    titleSource: "xmp",
    keywords: ["旅行", "京都", "夜景"],
    keywordsSource: "xmp",
    rights: "© 2024 Tyler Zhang",
    rightsSource: "xmp",
    rating: 5,
    ratingSource: "xmp",
    camera: "SONY ILCE-7M4",
    lens: "FE 24-70 F2.8",
    exposure: "1/125s · f/4.0",
    iso: 400,
    focal: 35,
    orientation: 1,
    orientationSource: "exif",
    gps: { lat: 35.0116, lon: 135.7681 },
    icc: "sRGB IEC61966-2.1",
    histogram: mockHistogram(rand),
  };
}

function mockHistogram(rand: () => number): Histogram {
  const bins = 64;
  const bell = (center: number, width: number) =>
    Array.from({ length: bins }, (_, i) => {
      const x = (i - center) / width;
      const y = Math.exp(-x * x) * (0.55 + rand() * 0.45);
      return Math.round(y * 1000);
    });
  return {
    bins,
    r: bell(30 + rand() * 8, 9),
    g: bell(32 + rand() * 8, 11),
    b: bell(28 + rand() * 10, 13),
    pixels: 6000 * 4000,
  };
}
