import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon, IconSprite } from "./icons";
import Inspector from "./components/Inspector";
import { Sidebar } from "./components/Sidebar";
import type { PhotoMeta } from "./data/meta";
import { defaultDir } from "./data/source";
import { formatBytes } from "./format";
import Browse, { type BrowseView, type GridStatus } from "./screens/Browse";
import { isComposing, isTextInput } from "./keys";

const EMPTY_STATUS: GridStatus = {
  dir: "",
  total: 0,
  selected: 0,
  knownBytes: 0,
  selectedBytes: 0,
  statsKnown: 0,
  statsComplete: false,
  view: "folder",
  dated: 0,
  cell: 128,
  currentName: null,
  currentPath: null,
  currentSize: null,
  currentRating: null,
};

/** 墙上时间：EXIF/XMP 给的是"拍摄地时间"，直接用；推断值用本机 mtime 格式化。 */
function formatLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

/** 路径 → 面包屑：只取最后三段，前面用省略号收掉（深路径不给标题栏塞爆）。 */
function crumbsOf(dir: string): Array<{ name: string; path: string }> {
  // 浏览器预览用的是 mock:// 这类伪协议，显示时剥掉协议头。
  const clean = dir.replace(/^[a-zA-Z][\w+.-]*:\/\//, "/");
  const parts = clean.split(/[\\/]/).filter(Boolean);
  const sep = clean.includes("\\") ? "\\" : "/";
  const prefix = clean.includes("\\") && parts[0]?.endsWith(":") ? "" : sep;
  const out: Array<{ name: string; path: string }> = [];
  let cur = prefix;
  const start = Math.max(0, parts.length - 3);
  for (let i = 0; i < parts.length; i++) {
    cur = cur ? cur.replace(/[\\/]$/, "") + sep + parts[i] : sep + parts[i];
    if (i >= start) out.push({ name: parts[i], path: cur });
  }
  return out;
}

function parentOf(dir: string): string | null {
  const trimmed = dir.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(trimmed) || trimmed === "") return null;
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  if (idx < 0) return null;
  const parent = trimmed.slice(0, idx);
  return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent || "/";
}

export default function App() {
  const [cellIdx, setCellIdx] = useState(2);
  const [status, setStatus] = useState<GridStatus>(EMPTY_STATUS);
  const [meta, setMeta] = useState<PhotoMeta | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dir, setDir] = useState("");
  const [view, setView] = useState<BrowseView>("folder");
  const [reloadKey, setReloadKey] = useState(0);
  const [hist, setHist] = useState<{ list: string[]; i: number }>({ list: [], i: -1 });
  // 屏 2（M5）：viewer 挂在 Browse 里（它持有 entries/评分/收藏），App 只留
  // 「是否打开」与「请求打开」两个信号，用来让全局键让位、接工具栏按钮。
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerRequest, setViewerRequest] = useState(0);

  const openDir = useCallback((path: string) => {
    if (!path) return;
    setDir(path);
    setHist((h) => {
      if (h.list[h.i] === path) return h;
      const list = h.list.slice(0, h.i + 1);
      list.push(path);
      return { list, i: list.length - 1 };
    });
  }, []);

  useEffect(() => {
    void defaultDir().then((d) => openDir(d));
  }, [openDir]);

  // Browse 的状态回传每帧都可能触发；内容相同就不换引用，避免自激重渲染。
  const onStatus = useCallback((s: GridStatus) => {
    setStatus((prev) => (JSON.stringify(prev) === JSON.stringify(s) ? prev : s));
  }, []);

  const back = useCallback(() => {
    setHist((h) => {
      if (h.i <= 0) return h;
      setDir(h.list[h.i - 1]);
      return { list: h.list, i: h.i - 1 };
    });
  }, []);

  const forward = useCallback(() => {
    setHist((h) => {
      if (h.i >= h.list.length - 1) return h;
      setDir(h.list[h.i + 1]);
      return { list: h.list, i: h.i + 1 };
    });
  }, []);

  const up = useCallback(() => {
    const p = parentOf(dir);
    if (p) openDir(p);
  }, [dir, openDir]);

  // 全局快捷键（§10.2）：Alt ← / → / ↑、Ctrl B、Ctrl Shift T、F5、Ctrl I。
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (isComposing(ev) || isTextInput(ev.target)) return;
      // 全屏看图期间键位全部归 viewer（§10.3），目录导航不跟着走。
      if (viewerOpen) return;
      if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
        if (ev.key === "ArrowLeft") {
          ev.preventDefault();
          back();
        } else if (ev.key === "ArrowRight") {
          ev.preventDefault();
          forward();
        } else if (ev.key === "ArrowUp") {
          ev.preventDefault();
          up();
        }
        return;
      }
      if (ev.key === "F5") {
        ev.preventDefault();
        setReloadKey((k) => k + 1);
        return;
      }
      if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
      const k = ev.key.toLowerCase();
      if (k === "i" && !ev.shiftKey) {
        ev.preventDefault();
        setInspectorOpen((v) => !v);
      } else if (k === "b" && !ev.shiftKey) {
        ev.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (k === "t" && ev.shiftKey) {
        ev.preventDefault();
        setView((v) => (v === "folder" ? "timeline" : "folder"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [back, forward, up, viewerOpen]);

  const crumbs = useMemo(() => crumbsOf(status.dir || dir), [status.dir, dir]);
  const currentExt = status.currentName?.split(".").pop()?.toUpperCase() ?? "";
  const takenLabel = meta
    ? `${meta.takenAtText ?? formatLocal(meta.takenAt)}${
        meta.takenSource === "inferred" ? "（推断）" : ""
      }`
    : "—";
  const dirName = useMemo(() => {
    const parts = (status.dir || dir).split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? "—";
  }, [status.dir, dir]);
  const whole = status.selected === 0;

  return (
    <div className="app" data-screen="browse" data-side={sidebarOpen ? "on" : "off"}>
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
          {crumbs.map((c, i) => (
            <span key={c.path} className="crumb-wrap">
              {i > 0 && <Icon id="i-chev-right" className="crumb-sep" />}
              <span
                className={`crumb${i === crumbs.length - 1 ? " cur" : ""}`}
                onClick={() => openDir(c.path)}
                title={c.path}
              >
                {c.name}
              </span>
            </span>
          ))}
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
          <button
            className="ibtn"
            title="后退"
            data-tip=""
            disabled={hist.i <= 0}
            onClick={back}
          >
            <Icon id="i-chev-left" />
            <span className="tip tip-l">
              后退 <kbd>Alt ←</kbd>
            </span>
          </button>
          <button
            className="ibtn"
            title="前进"
            disabled={hist.i >= hist.list.length - 1}
            onClick={forward}
          >
            <Icon id="i-chev-right" />
          </button>
          <button className="ibtn" title="上级目录" data-tip="" onClick={up}>
            <Icon id="i-up" />
            <span className="tip">
              上级目录 <kbd>Alt ↑</kbd>
            </span>
          </button>
        </div>
        <div className="tsep" />
        <div className="tgroup">
          <div className="seg">
            <button
              className={`seg-item${view === "folder" ? " active" : ""}`}
              onClick={() => setView("folder")}
              data-tip=""
            >
              <Icon id="i-grid" size="sm" />
              文件夹
              <span className="tip">
                文件夹视图 <kbd>Ctrl ⇧ T</kbd>
              </span>
            </button>
            <button
              className={`seg-item${view === "timeline" ? " active" : ""}`}
              onClick={() => setView("timeline")}
              data-tip=""
            >
              <Icon id="i-timeline" size="sm" />
              时间线
              <span className="tip">
                时间线视图 <kbd>Ctrl ⇧ T</kbd>
              </span>
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
            {view === "timeline" ? "拍摄时间 · 新→旧" : "名称 · 升序"}
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
          <button
            className="ibtn"
            title="全屏看图"
            data-tip=""
            onClick={() => setViewerRequest((n) => n + 1)}
          >
            <Icon id="i-fullscreen" />
            <span className="tip">
              全屏看图 <kbd>Enter</kbd>
            </span>
          </button>
        </div>
      </div>

      {/* 工作区 */}
      <div className="workspace">
        {sidebarOpen && (
          <Sidebar
            dir={status.dir || dir}
            onOpenDir={openDir}
            statsKnown={status.statsKnown}
            statsTotal={status.total}
          />
        )}
        <Browse
          dir={dir}
          view={view}
          reloadKey={reloadKey}
          cellIdx={cellIdx}
          onCellIdxChange={setCellIdx}
          onStatus={onStatus}
          openViewerKey={viewerRequest}
          onViewerOpen={setViewerOpen}
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
        <span>{formatBytes(whole ? status.knownBytes : status.selectedBytes)}</span>
        <div className="sb-mid" style={{ marginLeft: "var(--ds-space-5)" }}>
          <span className="sb-sep" />
          {whole ? (
            <>
              <span className="name">{dirName}</span>
              <span className="sb-num">{status.total} 项</span>
              <span>
                {status.statsComplete
                  ? `合计 ${formatBytes(status.knownBytes)}`
                  : `已统计 ${status.statsKnown}/${status.total}`}
              </span>
            </>
          ) : (
            <>
              <span className="name">{status.currentName ?? "—"}</span>
              <span className="sb-num">
                {meta?.width && meta?.height ? `${meta.width}×${meta.height}` : "—"}
              </span>
              <span>{meta ? meta.format.toUpperCase() : currentExt || "—"}</span>
              <span className="sb-num">{formatBytes(meta?.size ?? status.currentSize ?? 0)}</span>
              <span>{takenLabel}</span>
            </>
          )}
        </div>
        <div className="sb-right">
          {status.view === "timeline" ? (
            <span>
              时间线 <span className="sb-num">{status.dated} / {status.total}</span>
            </span>
          ) : (
            <span>
              索引 <span className="sb-num">{status.statsKnown} / {status.total}</span>
            </span>
          )}
          <span className="progress">
            <i
              style={{
                width: `${
                  status.total ? Math.round(((status.view === "timeline" ? status.dated : status.statsKnown) / status.total) * 100) : 0
                }%`,
              }}
            />
          </span>
          <span className="sb-sep" />
          <span>格宽 <span className="sb-num">{status.cell}</span> px</span>
          <span className="sb-sep" />
          <span>缩放 <span className="sb-num">100%</span></span>
        </div>
      </footer>
    </div>
  );
}
