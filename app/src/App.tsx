import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon, IconSprite } from "./icons";
import Inspector from "./components/Inspector";
import { Sidebar } from "./components/Sidebar";
import Toast, { type ToastData } from "./components/Toast";
import type { PhotoMeta } from "./data/meta";
import { isElevated, isTauri, launchTarget, resolveTarget } from "./data/source";
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

/** M9：拖放/关联进来的是不是本项目支持的图片（与 Rust 侧 read_images 的扩展名表一致）。 */
const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif|heics|heifs|tiff?|bmp|gif|avif)$/i;

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
  // 屏 3（M6）：编辑同样挂在 Browse 里，这里只发「请求打开」。
  const [editorRequest, setEditorRequest] = useState(0);
  // 屏 4（M7）：批量处理同款信号。
  const [batchRequest, setBatchRequest] = useState(0);
  // M9：双击关联文件 / 拖入图片时，要定位到看图的那一张；key 自增驱动 Browse。
  const [openFile, setOpenFile] = useState<{ path: string; key: number } | null>(null);
  // M9：系统级提示（管理员拖放限制、拖放解析失败）；与 Browse 的删除 Toast 同一组件。
  const [toast, setToast] = useState<ToastData | null>(null);
  const toastIdRef = useRef(0);

  const notify = useCallback((text: string, error = false) => {
    setToast({ id: ++toastIdRef.current, text, error });
  }, []);

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

  /** M9：自绘标题栏（decorations=false）必须自己接窗口动作，否则按钮是死的。 */
  const windowAction = useCallback((action: "minimize" | "toggleMaximize" | "close") => {
    if (!isTauri()) return;
    const w = getCurrentWindow();
    if (action === "minimize") void w.minimize();
    else if (action === "toggleMaximize") void w.toggleMaximize();
    else void w.close();
  }, []);

  /** 打开一个外部路径：目录直接进；文件进父目录并在看图里定位（M9 拖放/关联）。 */
  const openPath = useCallback(
    async (path: string) => {
      try {
        const t = await resolveTarget(path);
        if (!t.dir) return;
        openDir(t.dir);
        if (t.file) {
          if (!IMAGE_EXT.test(t.file)) {
            notify("这个文件不是支持的图片格式", true);
            return;
          }
          const file = t.file;
          setOpenFile((prev) => ({ path: file, key: (prev?.key ?? 0) + 1 }));
        }
      } catch (e) {
        notify(`打不开这个路径：${String(e)}`, true);
      }
    },
    [openDir, notify]
  );

  useEffect(() => {
    let alive = true;
    void launchTarget().then(async (t) => {
      if (!alive) return;
      if (t.dir) openDir(t.dir);
      if (t.file) {
        const file = t.file;
        setOpenFile((prev) => ({ path: file, key: (prev?.key ?? 0) + 1 }));
      }
      // 管理员进程收不到 Explorer 的 OLE 拖放（R13）：启动时明确告知，不静默失效。
      if (await isElevated()) {
        if (alive) notify("以管理员身份运行：资源管理器拖放不可用，请从侧栏进入图片所在目录", true);
      }
    });
    return () => {
      alive = false;
    };
  }, [openDir, notify]);

  // 拖放打开（M9）：整个窗口接收，取第一个路径；拖入目录进目录，拖入图片进父目录并看图。
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths.length > 0) {
          void openPath(event.payload.paths[0]);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [openPath]);

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
      } else if (k === "e" && !ev.shiftKey) {
        ev.preventDefault();
        setBatchRequest((n) => n + 1);
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
      <header className="titlebar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          <span className="brand-mark" data-tauri-drag-region>
            <Icon id="i-image" size="sm" />
          </span>
          <span className="brand-name" data-tauri-drag-region>Albumio</span>
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
        <div className="titlebar-pad" data-tauri-drag-region />
        <div className="winbtns">
          <button className="winbtn" title="最小化" onClick={() => windowAction("minimize")}>
            <Icon id="i-minus" size="xs" />
          </button>
          <button className="winbtn" title="最大化" onClick={() => windowAction("toggleMaximize")}>
            <Icon id="i-maximize" size="xs" />
          </button>
          <button className="winbtn close" title="关闭" onClick={() => windowAction("close")}>
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
          <button
            className="tbtn"
            title="批量处理"
            data-tip=""
            onClick={() => setBatchRequest((n) => n + 1)}
          >
            <Icon id="i-layers" size="sm" />
            批量
            <span className="tip">
              批量处理 <kbd>Ctrl E</kbd>
            </span>
          </button>
          <button
            className="tbtn"
            data-tip=""
            onClick={() => setEditorRequest((n) => n + 1)}
          >
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
          openEditorKey={editorRequest}
          openBatchKey={batchRequest}
          openFile={openFile?.path ?? null}
          openFileKey={openFile?.key ?? 0}
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

      <Toast data={toast} onDone={() => setToast(null)} />
    </div>
  );
}
