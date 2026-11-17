/**
 * 屏 2 全屏看图（04-项目计划 M5）。
 *
 * 结构与数值对齐 `design/index.html` 的 `#ov-viewer`：顶部浮条、舞台、缩放条、
 * 信息浮层、胶片条。语义约定：
 * - 100% = L2 代理的 1 个像素对应 1 个 CSS 像素；「适应」= min(舞台宽/宽, 舞台高/高, 1)，
 *   小图不放大（`02-设计规范.md` §10.3）。
 * - 滚轮以光标为锚点缩放；Shift+滚轮水平平移；拖拽只在放大后有意义，但始终允许。
 * - 浮条静止 2.5s 淡出，鼠标移动唤回；键盘操作期间不隐藏（§11.1）。
 *
 * 代理与预取都走 `previewUrl`（L2 2048），翻页时相邻项已就绪，不出现白屏。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../icons";
import { formatBytes } from "../format";
import { isComposing, isTextInput } from "../keys";
import { HistogramChart } from "./Inspector";
import { loadMeta, type PhotoMeta } from "../data/meta";
import {
  previewUrl,
  releasePreview,
  thumbUrl,
  type Entry,
} from "../data/source";

const PAD_TOP = 64; // 浮条 40 + 上下 12
const PAD_X = 32;
const PAD_BOTTOM = 96; // 胶片条 72 + 上下 12
const ZOOM_MIN = 0.02;
const ZOOM_MAX = 8;
const STEP = 1.25;
const CHROME_IDLE_MS = 2500;
const FILM_RADIUS = 40;
const FILM_THUMB_RADIUS = 24;

interface ViewerProps {
  items: Entry[];
  index: number;
  onIndexChange: (index: number) => void;
  ratings: Map<string, number>;
  favorites: Set<string>;
  onRate: (path: string, rating: number) => void;
  onFavorite: (path: string) => void;
  /** 屏 3（M6）：从看图进入编辑。 */
  onEdit: (path: string) => void;
  onClose: () => void;
}

interface Loaded {
  path: string;
  url: string;
  w: number;
  h: number;
}

function formatLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export default function Viewer({
  items,
  index,
  onIndexChange,
  ratings,
  favorites,
  onRate,
  onFavorite,
  onEdit,
  onClose,
}: ViewerProps) {
  const safeIndex = clamp(index, 0, Math.max(0, items.length - 1));
  const item = items[safeIndex];
  const path = item?.path ?? null;

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // L1 兜底：网格里通常已经解码过，打开 viewer 先贴它，L2 到了再换，避免冷开白屏。
  const [quick, setQuick] = useState<string | null>(null);
  const [meta, setMeta] = useState<PhotoMeta | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const [filmOpen, setFilmOpen] = useState(true);
  const [chrome, setChrome] = useState(true);
  const [dragging, setDragging] = useState(false);
  // null = 适应窗口（跟随窗口尺寸重算）；数字 = 用户定的倍率（100% = L2 1:1）。
  const [zoom, setZoom] = useState<number | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fitScale, setFitScale] = useState(1);
  const [stageSize, setStageSize] = useState({ w: 1, h: 1 });
  const [filmThumbs, setFilmThumbs] = useState<Map<string, string>>(new Map());

  const stageRef = useRef<HTMLDivElement | null>(null);
  const filmRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<number | null>(null);
  const fitRef = useRef(1);
  const panRef = useRef(pan);
  const effZoomRef = useRef(1);
  const chromeTimer = useRef(0);
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const filmDragRef = useRef(false);
  const heldRef = useRef<Map<string, string>>(new Map());
  // wheel 期间为 true → transition=none（跟手）；停 150ms 后回 false → 平滑过渡。
  const zoomingRef = useRef(false);
  const zoomingTimer = useRef(0);

  const nat = loaded ? { w: loaded.w, h: loaded.h } : null;
  const effZoom = zoom ?? fitScale;

  zoomRef.current = zoom;
  fitRef.current = fitScale;
  panRef.current = pan;
  effZoomRef.current = effZoom;

  /* ---------------- 舞台尺寸与适应比例 ---------------- */

  const measure = useCallback(() => {
    const el = stageRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const w = Math.max(1, r.width - PAD_X * 2);
    const h = Math.max(1, r.height - PAD_TOP - PAD_BOTTOM);
    return { left: r.left, top: r.top, w, h, cx: r.left + PAD_X + w / 2, cy: r.top + PAD_TOP + h / 2 };
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const sync = () => {
      const m = measure();
      if (!m) return;
      setStageSize((prev) => (prev.w === m.w && prev.h === m.h ? prev : { w: m.w, h: m.h }));
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  useEffect(() => {
    if (!nat) return;
    setFitScale(Math.min(stageSize.w / nat.w, stageSize.h / nat.h, 1));
  }, [nat, stageSize]);

  const clampPan = useCallback(
    (p: { x: number; y: number }, z: number) => {
      if (!nat) return { x: 0, y: 0 };
      const mx = Math.max(0, (nat.w * z - stageSize.w) / 2);
      const my = Math.max(0, (nat.h * z - stageSize.h) / 2);
      return { x: clamp(p.x, -mx, mx), y: clamp(p.y, -my, my) };
    },
    [nat, stageSize]
  );

  /* ---------------- L2 代理与相邻预取 ---------------- */

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setQuick(null);
    void thumbUrl(path, "l1")
      .then((url) => {
        if (alive) setQuick(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    void previewUrl(path)
      .then((url) => {
        if (!alive) {
          releasePreview(path, url);
          return;
        }
        const probe = new Image();
        const commit = (w: number, h: number) => {
          if (!alive) return;
          heldRef.current.set(path, url);
          setLoaded({ path, url, w, h });
        };
        probe.onload = () => commit(probe.naturalWidth || 2048, probe.naturalHeight || 1365);
        probe.onerror = () => commit(2048, 1365);
        probe.src = url;
      })
      .catch(() => {
        /* 解码失败由后端错误决定占位，viewer 不在这里造图 */
      });
    return () => {
      alive = false;
    };
  }, [path]);

  // 只留住当前、前后各一张与正在显示的那张；更远的 blob 立即归还。
  useEffect(() => {
    const keep = new Set<string>();
    for (const i of [safeIndex - 1, safeIndex, safeIndex + 1]) {
      const p = items[i]?.path;
      if (p) keep.add(p);
    }
    if (loaded) keep.add(loaded.path);
    for (const [p, url] of heldRef.current) {
      if (keep.has(p)) continue;
      releasePreview(p, url);
      heldRef.current.delete(p);
    }
  }, [safeIndex, items, loaded]);

  useEffect(() => {
    for (const i of [safeIndex - 2, safeIndex + 2]) {
      const p = items[i]?.path;
      if (!p || heldRef.current.has(p)) continue;
      void previewUrl(p)
        .then((url) => {
          if (heldRef.current.has(p)) {
            /* 别人先拿到了同一个 URL，缓存里是同一份 */
            return;
          }
          heldRef.current.set(p, url);
        })
        .catch(() => {});
    }
  }, [safeIndex, items]);

  useEffect(
    () => () => {
      for (const [p, url] of heldRef.current) releasePreview(p, url);
      heldRef.current.clear();
    },
    []
  );

  /* ---------------- 元数据与胶片条缩略图 ---------------- */

  useEffect(() => {
    if (!path) {
      setMeta(null);
      return;
    }
    let alive = true;
    setMeta(null);
    void loadMeta(path)
      .then((m) => {
        if (alive) setMeta(m);
      })
      .catch(() => {
        if (alive) setMeta(null);
      });
    return () => {
      alive = false;
    };
  }, [path]);

  const filmRange = useMemo(() => {
    const lo = Math.max(0, safeIndex - FILM_RADIUS);
    const hi = Math.min(items.length, safeIndex + FILM_RADIUS + 1);
    return { lo, hi };
  }, [safeIndex, items.length]);

  useEffect(() => {
    if (!filmOpen) return;
    const lo = Math.max(0, safeIndex - FILM_THUMB_RADIUS);
    const hi = Math.min(items.length, safeIndex + FILM_THUMB_RADIUS + 1);
    const wanted = items.slice(lo, hi).map((e) => e.path);
    let alive = true;
    void Promise.all(
      wanted.map(async (p) => [p, await thumbUrl(p, "l0")] as const)
    )
      .then((pairs) => {
        if (!alive) return;
        setFilmThumbs((prev) => {
          const next = new Map(prev);
          for (const [p, u] of pairs) next.set(p, u);
          // 只留当前窗口附近的条目，长会话不在内存里无限累积（blob 在共享缓存里）。
          const lo2 = Math.max(0, safeIndex - FILM_THUMB_RADIUS * 2);
          const hi2 = Math.min(items.length, safeIndex + FILM_THUMB_RADIUS * 2 + 1);
          const keep = new Set(items.slice(lo2, hi2).map((e) => e.path));
          for (const p of next.keys()) if (!keep.has(p)) next.delete(p);
          return next;
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [filmOpen, safeIndex, items]);

  /* ---------------- 浮条显隐（§11.1） ---------------- */

  const showChrome = useCallback(() => {
    setChrome(true);
    window.clearTimeout(chromeTimer.current);
    chromeTimer.current = window.setTimeout(() => setChrome(false), CHROME_IDLE_MS);
  }, []);

  /** 键盘操作只让浮条出现，不重新计时——键位期间不能淡出。 */
  const pinChrome = useCallback(() => {
    window.clearTimeout(chromeTimer.current);
    setChrome(true);
  }, []);

  useEffect(() => {
    showChrome();
    return () => window.clearTimeout(chromeTimer.current);
  }, [showChrome]);

  /* ---------------- 缩放与平移 ---------------- */

  const applyZoom = useCallback(
    (next: number | null, anchor?: { x: number; y: number }) => {
      if (!nat) return;
      const z0 = zoomRef.current ?? fitRef.current;
      const z1 = next === null ? fitRef.current : clamp(next, ZOOM_MIN, ZOOM_MAX);
      if (anchor) {
        const p0 = panRef.current;
        const k = z1 / (z0 || 1);
        setPan(
          clampPan(
            {
              x: anchor.x - k * (anchor.x - p0.x),
              y: anchor.y - k * (anchor.y - p0.y),
            },
            z1
          )
        );
      } else if (next === null) {
        setPan({ x: 0, y: 0 });
      } else {
        setPan((prev) => clampPan(prev, z1));
      }
      setZoom(next);
    },
    [nat, clampPan]
  );

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      showChrome();
      if (!nat) return;

      // wheel 期间 transition=none（跟手无极调节）。
      zoomingRef.current = true;
      window.clearTimeout(zoomingTimer.current);
      zoomingTimer.current = window.setTimeout(() => {
        zoomingRef.current = false;
        // 强制重渲染让 photoStyle.transition 切回来。
        setPan((p) => ({ ...p }));
      }, 150);

      if (ev.shiftKey) {
        const dx = ev.deltaX || ev.deltaY;
        setPan((prev) => clampPan({ x: prev.x - dx, y: prev.y }, effZoomRef.current));
        return;
      }
      const m = measure();
      if (!m) return;
      const factor = Math.exp(-ev.deltaY * 0.0015);
      applyZoom(effZoomRef.current * factor, {
        x: ev.clientX - m.cx,
        y: ev.clientY - m.cy,
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoom, clampPan, measure, nat, showChrome]);

  const onPointerDown = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (ev.button !== 0) return;
    dragRef.current = { x: ev.clientX, y: ev.clientY, px: panRef.current.x, py: panRef.current.y };
    setDragging(true);
    ev.currentTarget.setPointerCapture(ev.pointerId);
  };

  const onPointerMove = (ev: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setPan(
      clampPan({ x: d.px + ev.clientX - d.x, y: d.py + ev.clientY - d.y }, effZoomRef.current)
    );
  };

  const endDrag = (ev: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (ev.currentTarget.hasPointerCapture(ev.pointerId)) {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    }
  };

  /* ---------------- 翻页 ---------------- */

  const go = useCallback(
    (i: number) => onIndexChange(clamp(i, 0, Math.max(0, items.length - 1))),
    [items.length, onIndexChange]
  );

  // 换图回到「适应」，上一张的缩放不该带到下一张。
  useEffect(() => {
    setZoom(null);
    setPan({ x: 0, y: 0 });
  }, [path]);

  useEffect(() => {
    if (filmDragRef.current) return;
    const on = filmRef.current?.querySelector(".film-item.on") as HTMLElement | null;
    on?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [safeIndex, filmOpen]);

  /* ---------------- 键位（§10.3） ---------------- */

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (isComposing(ev) || isTextInput(ev.target)) return;
      if (!path) return;
      const k = ev.key;
      const hasMod = ev.ctrlKey || ev.metaKey || ev.altKey;

      const zoomBy = (factor: number) => {
        ev.preventDefault();
        pinChrome();
        applyZoom((zoomRef.current ?? fitRef.current) * factor);
      };

      switch (k) {
        case "ArrowLeft":
          ev.preventDefault();
          pinChrome();
          go(safeIndex - 1);
          return;
        case "ArrowRight":
          ev.preventDefault();
          pinChrome();
          go(safeIndex + 1);
          return;
        case " ":
          ev.preventDefault();
          pinChrome();
          go(safeIndex + (ev.shiftKey ? -1 : 1));
          return;
        case "Home":
          ev.preventDefault();
          pinChrome();
          go(0);
          return;
        case "End":
          ev.preventDefault();
          pinChrome();
          go(items.length - 1);
          return;
        case "Escape":
          ev.preventDefault();
          pinChrome();
          onClose();
          return;
        case "+":
        case "=":
          if (hasMod) return;
          zoomBy(STEP);
          return;
        case "-":
        case "_":
          if (hasMod) return;
          zoomBy(1 / STEP);
          return;
        case "f":
        case "F":
          ev.preventDefault();
          pinChrome();
          applyZoom(null);
          return;
        case "z":
        case "Z":
          ev.preventDefault();
          pinChrome();
          applyZoom(1);
          return;
        case "2":
          if (hasMod || !nat) return;
          ev.preventDefault();
          pinChrome();
          applyZoom(Math.max(stageSize.w / nat.w, stageSize.h / nat.h));
          return;
        case "c":
        case "C":
          ev.preventDefault();
          pinChrome();
          applyZoom(zoomRef.current === null ? 1 : null);
          return;
        case "i":
        case "I":
          ev.preventDefault();
          pinChrome();
          setInfoOpen((v) => !v);
          return;
        case "t":
        case "T":
          ev.preventDefault();
          pinChrome();
          setFilmOpen((v) => !v);
          return;
        case "e":
        case "E":
          // 屏 3（M6）：E 进入编辑，参数按当前项载入。
          ev.preventDefault();
          pinChrome();
          onEdit(path);
          return;
        default:
          break;
      }
      if (hasMod) return;
      if (/^[0-5]$/.test(k)) {
        ev.preventDefault();
        pinChrome();
        onRate(path, Number(k));
        return;
      }
      if (k.toLowerCase() === "p") {
        ev.preventDefault();
        pinChrome();
        onFavorite(path);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    applyZoom,
    go,
    items.length,
    nat,
    onClose,
    onEdit,
    onFavorite,
    onRate,
    path,
    pinChrome,
    safeIndex,
    stageSize,
  ]);

  if (!item) return null;

  const rating = ratings.get(item.path) ?? meta?.rating ?? 0;
  const faved = favorites.has(item.path);
  const dims = meta?.width && meta?.height ? `${meta.width}×${meta.height}` : "—";
  const size = meta ? formatBytes(meta.size) : "—";
  const percent = Math.round(effZoom * 100);

  const photoStyle: CSSProperties = {
    width: nat ? `${nat.w}px` : "100%",
    height: nat ? `${nat.h}px` : "100%",
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${effZoom})`,
    // wheel / drag 期间关 transition（跟手无极调节）；静止后给 60ms 让键位缩放平滑过渡。
    transition: dragging || zoomingRef.current ? "none" : "transform 60ms cubic-bezier(.22,.61,.36,1)",
  };

  const filmItems = items.slice(filmRange.lo, filmRange.hi);
  const taken = meta ? meta.takenAtText ?? formatLocal(meta.takenAt) : "—";
  const stars = rating > 0 ? "★".repeat(rating) : "—";

  return (
    <div
      className={`overlay viewer${chrome ? "" : " chrome-hidden"}`}
      data-screen="viewer"
      onMouseMove={showChrome}
    >
      <div className="v-top floatbar">
        <button className="ibtn" data-tip="" title="返回 (Esc)" onClick={onClose}>
          <Icon id="i-back" />
          <span className="tip tip-l">
            返回 <kbd>Esc</kbd>
          </span>
        </button>
        <span className="fb-title" title={item.name}>
          {item.name}
        </span>
        <span className="fb-count">
          {safeIndex + 1} / {items.length}
        </span>
        <div className="fb-sep" />
        <span className="fb-count">
          {dims} · {size}
        </span>
        <div className="fb-spacer" />
        <button
          className={`ibtn${infoOpen ? " on" : ""}`}
          data-tip=""
          title="图片信息 (I)"
          onClick={() => setInfoOpen((v) => !v)}
        >
          <Icon id="i-info" />
          <span className="tip">
            图片信息 <kbd>I</kbd>
          </span>
        </button>
        <button className="ibtn" title="编辑 (E)" onClick={() => onEdit(item.path)}>
          <Icon id="i-sliders" />
        </button>
        <button
          className={`ibtn${faved ? " on" : ""}`}
          data-tip=""
          title="收藏 (P)"
          onClick={() => onFavorite(item.path)}
        >
          <Icon id="i-heart" />
          <span className="tip">
            收藏 <kbd>P</kbd>
          </span>
        </button>
        <button className="ibtn" data-tip="" title="关闭 (Esc)" onClick={onClose}>
          <Icon id="i-x" />
          <span className="tip">
            关闭 <kbd>Esc</kbd>
          </span>
        </button>
      </div>

      <div
        className="v-stage"
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className={`v-photo${dragging ? " dragging" : ""}`} style={photoStyle}>
          {loaded?.path === path ? (
            <img src={loaded.url} alt={item.name} draggable={false} />
          ) : quick ? (
            <img className="v-quick" src={quick} alt={item.name} draggable={false} />
          ) : loaded ? (
            <img src={loaded.url} alt={item.name} draggable={false} />
          ) : null}
        </div>
      </div>

      {infoOpen ? (
        <aside className="v-info show">
          <div className="insp-title" style={{ marginTop: 0 }}>
            <span>拍摄</span>
          </div>
          <div className="field">
            <span className="field-k">相机</span>
            <span className="field-v">{meta?.camera ?? "—"}</span>
          </div>
          <div className="field">
            <span className="field-k">镜头</span>
            <span className="field-v mono">{meta?.lens ?? "—"}</span>
          </div>
          <div className="field">
            <span className="field-k">曝光</span>
            <span className="field-v mono">
              {meta ? [meta.exposure, meta.iso ? `ISO ${meta.iso}` : null].filter(Boolean).join(" · ") || "—" : "—"}
            </span>
          </div>
          <div className="field">
            <span className="field-k">焦距</span>
            <span className="field-v mono">
              {meta?.focal != null ? `${Math.round(meta.focal)} mm` : "—"}
            </span>
          </div>
          <div className="field">
            <span className="field-k">时间</span>
            <span className="field-v mono">{taken}</span>
          </div>
          <div className="field">
            <span className="field-k">评分</span>
            <span className="field-v">{stars}</span>
          </div>
          <div className="insp-title">
            <span>直方图</span>
          </div>
          {meta ? <HistogramChart meta={meta} /> : <div className="hist" />}
          <div className="insp-title">
            <span>文件</span>
          </div>
          <div className="field">
            <span className="field-k">名称</span>
            <span className="field-v mono">{item.name}</span>
          </div>
          <div className="field">
            <span className="field-k">尺寸</span>
            <span className="field-v mono">{dims}</span>
          </div>
          <div className="field">
            <span className="field-k">大小</span>
            <span className="field-v mono">{size}</span>
          </div>
          <div className="field">
            <span className="field-k">格式</span>
            <span className="field-v">{meta ? meta.format.toUpperCase() : "—"}</span>
          </div>
          <div className="field">
            <span className="field-k">路径</span>
            <span className="field-v mono" title={item.path}>
              {item.path}
            </span>
          </div>
        </aside>
      ) : null}

      <div className="v-zoom floatbar">
        <button
          className="ibtn"
          data-tip=""
          title="缩小 (-)"
          onClick={() => applyZoom(effZoom / STEP)}
        >
          <Icon id="i-zoom-out" />
          <span className="tip">
            缩小 <kbd>-</kbd>
          </span>
        </button>
        <span className="pct">{percent}%</span>
        <button
          className="ibtn"
          data-tip=""
          title="放大 (+)"
          onClick={() => applyZoom(effZoom * STEP)}
        >
          <Icon id="i-zoom-in" />
          <span className="tip">
            放大 <kbd>+</kbd>
          </span>
        </button>
        <div className="fb-sep" />
        <button
          className={`ibtn${zoom === null ? " on" : ""}`}
          data-tip=""
          title="适应窗口 (F)"
          onClick={() => applyZoom(null)}
        >
          <Icon id="i-fit" />
          <span className="tip">
            适应窗口 <kbd>F</kbd>
          </span>
        </button>
        <button
          className={`ibtn${zoom === 1 ? " on" : ""}`}
          data-tip=""
          title="实际像素 (Z)"
          onClick={() => applyZoom(1)}
        >
          <Icon id="i-actual" />
          <span className="tip">
            实际像素 <kbd>Z</kbd>
          </span>
        </button>
        <button
          className={`ibtn${filmOpen ? " on" : ""}`}
          data-tip=""
          title="胶片条 (T)"
          onClick={() => setFilmOpen((v) => !v)}
        >
          <Icon id="i-film" />
          <span className="tip">
            胶片条 <kbd>T</kbd>
          </span>
        </button>
      </div>

      {filmOpen ? (
        <div className="v-bottom">
          <div
            className="film"
            ref={filmRef}
            onPointerDown={() => {
              filmDragRef.current = true;
            }}
            onPointerUp={() => {
              filmDragRef.current = false;
            }}
            onPointerLeave={() => {
              filmDragRef.current = false;
            }}
          >
            {filmItems.map((e, i) => {
              const at = filmRange.lo + i;
              const thumb = filmThumbs.get(e.path);
              return (
                <button
                  key={e.path}
                  className={`film-item${at === safeIndex ? " on" : ""}`}
                  title={e.name}
                  onClick={() => go(at)}
                >
                  {thumb ? <img src={thumb} alt="" draggable={false} /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
