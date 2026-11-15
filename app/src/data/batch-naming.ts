/**
 * 批量处理的命名与尺寸规则（04-项目计划 M7）。
 *
 * 这里只放纯函数：浏览器模拟要用，`node --test` 也要直接跑，
 * 所以不依赖 Tauri API；Rust 端 `albumio-core/src/batch.rs` 保持同一套规则。
 */

export type ResizeMode = "none" | "long2048" | "long1280" | "percent50";

export function expandPattern(
  pattern: string,
  ctx: Record<string, string | number>
): string {
  return pattern.replace(/\{([^{}]+)\}/g, (all, token: string) => {
    const v = ctx[token];
    return v === undefined ? all : String(v);
  });
}

export function sanitizeName(raw: string): string {
  return raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[ .]+$/, "")
    .trim();
}

export function join(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith("\\") || dir.endsWith("/") ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export function uniqueName(
  outDir: string,
  base: string,
  ext: string,
  taken: Set<string>
): { name: string; conflict: boolean } {
  for (let n = 0; ; n++) {
    const name = n === 0 ? `${base}.${ext}` : `${base}_${n}.${ext}`;
    const key = join(outDir, name).toLowerCase();
    if (!taken.has(key)) {
      taken.add(key);
      return { name, conflict: n > 0 };
    }
  }
}

export function resizeDims(
  w: number,
  h: number,
  mode: ResizeMode
): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  if (mode === "none") return { width: w, height: h };
  if (mode === "percent50") {
    return { width: Math.max(1, Math.round(w / 2)), height: Math.max(1, Math.round(h / 2)) };
  }
  const edge = mode === "long2048" ? 2048 : 1280;
  if (Math.max(w, h) <= edge) return { width: w, height: h };
  return w >= h
    ? { width: edge, height: Math.max(1, Math.round((h * edge) / w)) }
    : { width: Math.max(1, Math.round((w * edge) / h)), height: edge };
}
