import { useCallback, useEffect, useState } from "react";
import { Icon, IconSprite } from "./icons";
import Inspector from "./components/Inspector";
import type { PhotoMeta } from "./data/meta";
import Browse, { type GridStatus } from "./screens/Browse";
import { isComposing, isTextInput } from "./keys";

const EMPTY_STATUS: GridStatus = {
  dir: "",
  total: 0,
  selected: 0,
  knownBytes: 0,
  statsComplete: false,
  cell: 128,
  currentName: null,
  currentPath: null,
  currentSize: null,
  currentRating: null,
};

function formatBytes(n: number): string {
  if (n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** 墙上时间：EXIF/XMP 给的是"拍摄地时间"，直接用；推断值用本机 mtime 格式化。 */
function formatLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

export default function App() {
  const [cellIdx, setCellIdx] = useState(2);
  const [status, setStatus] = useState<GridStatus>(EMPTY_STATUS);
  const [meta, setMeta] = useState<PhotoMeta | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);

  // Browse 的状态回传每帧都可能触发；内容相同就不换引用，避免自激重渲染。
  const onStatus = useCallback((s: GridStatus) => {
    setStatus((prev) => (JSON.stringify(prev) === JSON.stringify(s) ? prev : s));
  }, []);

  // Ctrl+I：显示/隐藏检查器（§10.2；刻意不用 Ctrl+Shift+I，避免撞 DevTools）
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.shiftKey || ev.altKey) return;
      if (ev.key.toLowerCase() !== "i") return;
      if (isComposing(ev) || isTextInput(ev.target)) return;
      ev.preventDefault();
      setInspectorOpen((v) => !v);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const currentExt = status.currentName?.split(".").pop()?.toUpperCase() ?? "";
  const takenLabel = meta
    ? `${meta.takenAtText ?? formatLocal(meta.takenAt)}${
        meta.takenSource === "inferred" ? "（推断）" : ""
      }`
    : "—";

  return (
    <div className="app" data-screen="browse">
      <IconSprite />

      {/* 标题栏 */}
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">
            <Icon id="i-image" size="sm" />
          </span>
          <span className="brand-name">Albumio</span>
        </div>
        <nav className="crumbs">
          <span className="crumb">图片</span>
          <Icon id="i-chev-right" className="crumb-sep" />
          <span className="crumb">2024</span>
          <Icon id="i-chev-right" className="crumb-sep" />
          <span className="crumb cur">京都</span>
        </nav>
        <div className="titlebar-pad" />
        <div className="winbtns">
          <button className="winbtn" title="最小化">
            <Icon id="i-minus" size="xs" />
          </button>
          <button className="winbtn" title="最大化">
            <Icon id="i-maximize" size="xs" />
          </button>
          <button className="winbtn close" title="关闭">
            <Icon id="i-x" size="xs" />
          </button>
        </div>
      </header>

      {/* 工具条 */}
      <div className="toolbar">
        <div className="tgroup">
          <button className="ibtn" title="后退" data-tip="">
            <Icon id="i-chev-left" />
            <span className="tip tip-l">
              后退 <kbd>Alt ←</kbd>
            </span>
          </button>
          <button className="ibtn" title="前进" disabled>
            <Icon id="i-chev-right" />
          </button>
          <button className="ibtn" title="上级目录" data-tip="">
            <Icon id="i-up" />
            <span className="tip">
              上级目录 <kbd>Alt ↑</kbd>
            </span>
          </button>
        </div>
        <div className="tsep" />
        <div className="tgroup">
          <div className="seg">
            <button className="seg-item active">
              <Icon id="i-grid" size="sm" />
              文件夹
            </button>
            <button className="seg-item">
              <Icon id="i-timeline" size="sm" />
              时间线
            </button>
          </div>
          <div className="zoomctl">
            <Icon id="i-grid" size="sm" />
            <input
              className="lr"
              type="range"
              min="1"
              max="5"
              step="1"
              value={cellIdx}
              onChange={(e) => setCellIdx(Number(e.target.value))}
              aria-label="缩略图尺寸"
            />
          </div>
        </div>
        <div className="tsep" />
        <div className="tgroup">
          <button className="tbtn" title="排序">
            <Icon id="i-sort" size="sm" />
            名称 · 升序
          </button>
        </div>
        <div className="tgroup" style={{ flex: 1, minWidth: 0 }}>
          <label className="search" data-tip="">
            <Icon id="i-search" size="sm" />
            <input placeholder="搜索文件名、标签、相机…" />
            <span className="tip">
              搜索当前目录 <kbd>Ctrl F</kbd>
            </span>
          </label>
        </div>
        <div className="tgroup">
          <button className="tbtn" data-tip="">
            <Icon id="i-layers" size="sm" />
            批量
            <span className="tip">
              批量处理 <kbd>Ctrl E</kbd>
            </span>
          </button>
          <button className="tbtn" data-tip="">
            <Icon id="i-sliders" size="sm" />
            编辑
            <span className="tip">
              编辑当前图片 <kbd>E</kbd>
            </span>
          </button>
          <button className="ibtn" title="全屏看图" data-tip="">
            <Icon id="i-fullscreen" />
            <span className="tip">
              全屏看图 <kbd>Enter</kbd>
            </span>
          </button>
        </div>
      </div>

      {/* 工作区 */}
      <div className="workspace">
        <aside className="sidebar">
          <div className="side-scroll" />
        </aside>
        <Browse
          cellIdx={cellIdx}
          onCellIdxChange={setCellIdx}
          onStatus={onStatus}
        />
        <aside className="inspector" hidden={!inspectorOpen}>
          <div className="rail insp-rail">
            <button className="ibtn" title="展开检查器" data-tip="">
              <Icon id="i-panel-right" />
              <span className="tip tip-side">
                展开检查器 <kbd>Ctrl I</kbd>
              </span>
            </button>
          </div>
          <Inspector
            path={status.currentPath}
            rating={status.currentRating}
            onMeta={setMeta}
          />
        </aside>
      </div>

      {/* 状态栏 */}
      <footer className="statusbar">
        <span>
          <span className="sb-num">{status.total}</span> 项
        </span>
        <span className="sb-sep" />
        <span>已选 <span className="sb-num">{status.selected}</span></span>
        <span className="sb-sep" />
        <span>{formatBytes(status.knownBytes)}</span>
        <div className="sb-mid" style={{ marginLeft: "var(--ds-space-5)" }}>
          <span className="sb-sep" />
          <span className="name">{status.currentName ?? "—"}</span>
          <span className="sb-num">
            {meta?.width && meta?.height ? `${meta.width}×${meta.height}` : "—"}
          </span>
          <span>{meta ? meta.format.toUpperCase() : currentExt || "—"}</span>
          <span className="sb-num">{formatBytes(meta?.size ?? status.currentSize ?? 0)}</span>
          <span>{takenLabel}</span>
        </div>
        <div className="sb-right">
          <span>索引 <span className="sb-num">{status.statsComplete ? status.total : 0} / {status.total}</span></span>
          <span className="progress"><i style={{ width: `${status.total ? (status.statsComplete ? 100 : 60) : 0}%` }} /></span>
          <span className="sb-sep" />
          <span>格宽 <span className="sb-num">{status.cell}</span> px</span>
          <span className="sb-sep" />
          <span>缩放 <span className="sb-num">100%</span></span>
        </div>
      </footer>
    </div>
  );
}
