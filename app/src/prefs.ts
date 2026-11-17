// 应用偏好：localStorage 封装（统一前缀、默认值、异常静默）。
// 主题偏好走 theme.ts 自己的 key（兼容现有代码）；其余这里统一存取。

const PREFIX = "albumio.";

export interface Prefs {
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  cellIdx: number; // 0–4
  view: "folder" | "timeline";
  window: { width: number; height: number; x: number; y: number; maximized: boolean } | null;
}

const DEFAULTS: Prefs = {
  sidebarOpen: true,
  inspectorOpen: true,
  cellIdx: 2,
  view: "folder",
  window: null,
};

function key(k: keyof Prefs): string {
  return PREFIX + k;
}

export function loadPrefs(): Prefs {
  const out = { ...DEFAULTS };
  try {
    const s = localStorage.getItem(key("sidebarOpen"));
    if (s) out.sidebarOpen = s === "1";
    const i = localStorage.getItem(key("inspectorOpen"));
    if (i) out.inspectorOpen = i === "1";
    const c = localStorage.getItem(key("cellIdx"));
    if (c) {
      const n = parseInt(c, 10);
      if (!Number.isNaN(n) && n >= 0 && n <= 4) out.cellIdx = n;
    }
    const v = localStorage.getItem(key("view"));
    if (v === "folder" || v === "timeline") out.view = v;
    const w = localStorage.getItem(key("window"));
    if (w) {
      try {
        const parsed = JSON.parse(w) as Prefs["window"];
        if (parsed && typeof parsed.width === "number" && typeof parsed.height === "number") {
          out.window = parsed;
        }
      } catch {
        /* 坏数据忽略 */
      }
    }
  } catch {
    /* 隐私模式等场景静默 */
  }
  return out;
}

export function savePrefs(p: Partial<Prefs>): void {
  try {
    if (typeof p.sidebarOpen === "boolean") localStorage.setItem(key("sidebarOpen"), p.sidebarOpen ? "1" : "0");
    if (typeof p.inspectorOpen === "boolean") localStorage.setItem(key("inspectorOpen"), p.inspectorOpen ? "1" : "0");
    if (typeof p.cellIdx === "number") localStorage.setItem(key("cellIdx"), String(p.cellIdx));
    if (p.view === "folder" || p.view === "timeline") localStorage.setItem(key("view"), p.view);
    if ("window" in p) {
      if (p.window) {
        localStorage.setItem(key("window"), JSON.stringify(p.window));
      } else {
        localStorage.removeItem(key("window"));
      }
    }
  } catch {
    /* 静默 */
  }
}
