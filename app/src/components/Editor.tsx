/**
 * 屏 3 非破坏性编辑（04-项目计划 M6）。
 *
 * 布局与 `design/index.html` 的 `#ov-edit` 一致：顶部浮条、画布 + 裁剪框、
 * 右侧 280 基础调整面板、底部 40 浮条。语义约定见 `02-设计规范.md` §10.4 / §11.4：
 * - 滑杆只写编辑栈，原图字节不变；
 * - 裁剪框在编辑态不参与预览，Enter 才写入编辑栈；Esc 退出裁剪不确认；
 * - 移除某步 = 该步停用（行变暗、计数减一），不是删参数，随时可以再点回来。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "../icons";
import Toast, { type ToastData } from "./Toast";
import { isComposing, isTextInput } from "../keys";
import type { Entry } from "../data/source";
import {
  DEFAULT_RECT,
  EMPTY_STATE,
  RATIOS,
  cloneState,
  editPreview,
  exportEdits,
  isFullRect,
  loadEdits,
  sameState,
  saveEdits,
  type CropRect,
  type EditState,
  type OpName,
  type RatioId,
} from "../data/edit";

interface EditorProps {
  items: Entry[];
  index: number;
  onIndexChange: (index: number) => void;
  /** 返回看图（设计稿的「返回看图」）。 */
  onBackToViewer: () => void;
  /** 关闭编辑，回到网格。 */
  onClose: () => void;
  /** 导出成功后通知外层重列（副本是目录里的新文件）。 */
  onExported?: () => void;
}

const RATIO_VALUE: Record<Exclude<RatioId, "free">, number> = {
  "1:1": 1,
  "3:2": 3 / 2,
  "4:3": 4 / 3,
  "16:9": 16 / 9,
};

const MIN_CROP = 0.05;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

type Handle = "g1" | "g2" | "g3" | "g4" | "move";

interface DragState {
  handle: Handle;
  startX: number;
  startY: number;
  rect: CropRect;
  base: EditState;
  frame: { w: number; h: number };
}

/** 旋转/翻转后，把裁剪矩形搬到新坐标系（保持框住同一块画面）。 */
export function transformRect(rect: CropRect, deg: number, flip: boolean): CropRect {
  let r = { ...rect };
  if (flip) r = { x: 1 - r.x - r.w, y: r.y, w: r.w, h: r.h };
  const turns = ((deg % 360) + 360) % 360 / 90;
  for (let i = 0; i < turns; i++) {
    r = { x: 1 - r.y - r.h, y: r.x, w: r.h, h: r.w };
  }
  return r;
}

export default function Editor({
  items,
  index,
  onIndexChange,
  onBackToViewer,
  onClose,
  onExported,
}: EditorProps) {
  const safeIndex = clamp(index, 0, Math.max(0, items.length - 1));
  const item = items[safeIndex];
  const path = item?.path ?? null;

  const [state, setState] = useState<EditState>(() => cloneState(EMPTY_STATE));
  const [history, setHistory] = useState<EditState[]>([]);
  const [, setFuture] = useState<EditState[]>([]);
  const [preview, setPreview] = useState<{ url: string; mock: boolean } | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [canvas, setCanvas] = useState({ w: 1, h: 1 });
  const [stale, setStale] = useState(false);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [busy, setBusy] = useState(false);

  const stateRef = useRef(state);
  stateRef.current = state;
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const previewRevokeRef = useRef<(() => void) | null>(null);
  const previewSeq = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  const toastId = useRef(0);
  // 进入裁剪工具前的已确认矩形，Esc 用它回退。
  const cropBaseRef = useRef<CropRect | null>(null);

  const showToast = useCallback((text: string, error = false) => {
    setToast({ id: ++toastId.current, text, error });
  }, []);

  /* ---------------- 画布尺寸 ---------------- */

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const sync = () => {
      const r = el.getBoundingClientRect();
      setCanvas((prev) =>
        Math.abs(prev.w - r.width) < 0.5 && Math.abs(prev.h - r.height) < 0.5
          ? prev
          : { w: r.width, h: r.height }
      );
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------------- 载入与保存 ---------------- */

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setStale(false);
    setHistory([]);
    setFuture([]);
    void loadEdits(path)
      .then((r) => {
        if (!alive) return;
        setState(r.state);
        setStale(r.stale);
      })
      .catch((e) => {
        if (!alive) return;
        setState(cloneState(EMPTY_STATE));
        showToast(`读取编辑失败：${String(e)}`, true);
      });
    return () => {
      alive = false;
    };
  }, [path, showToast]);

  // 改动后 400ms 落盘；关闭/切图前显式 flush 一次。
  const flush = useCallback(async () => {
    if (!path) return;
    try {
      const r = await saveEdits(path, stateRef.current);
      if (r.warnings.length) showToast(r.warnings[0], true);
    } catch (e) {
      showToast(`保存编辑失败：${String(e)}`, true);
    }
  }, [path, showToast]);

  useEffect(() => {
    if (!path) return;
    const t = window.setTimeout(() => {
      void flush();
    }, 400);
    return () => window.clearTimeout(t);
  }, [state, path, flush]);

  /* ---------------- 预览 ---------------- */

  useEffect(() => {
    if (!path) return;
    const seq = ++previewSeq.current;
    const timer = window.setTimeout(() => {
      void editPreview(path, state)
        .then((r) => {
          if (seq !== previewSeq.current) {
            r.revoke();
            return;
          }
          previewRevokeRef.current?.();
          previewRevokeRef.current = r.revoke;
          setPreview({ url: r.url, mock: !!r.mockFilter });
        })
        .catch((e) => {
          if (seq === previewSeq.current) showToast(`预览失败：${String(e)}`, true);
        });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [path, state, showToast]);

  useEffect(
    () => () => {
      previewRevokeRef.current?.();
      previewRevokeRef.current = null;
    },
    []
  );

  const probeImage = useCallback((el: HTMLImageElement | null) => {
    if (!el) return;
    const commit = () => {
      if (el.naturalWidth && el.naturalHeight) {
        setNat((prev) =>
          prev?.w === el.naturalWidth && prev?.h === el.naturalHeight
            ? prev
            : { w: el.naturalWidth, h: el.naturalHeight }
        );
      }
    };
    if (el.complete) commit();
  }, []);

  /* ---------------- 状态变更与撤销 ---------------- */

  const apply = useCallback(
    (patch: Partial<EditState> | ((p: EditState) => EditState), record = true) => {
      const prev = stateRef.current;
      const next = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
      if (sameState(prev, next) && JSON.stringify(prev) === JSON.stringify(next)) return;
      if (record) {
        setHistory((h) => [...h.slice(-49), cloneState(prev)]);
        setFuture([]);
      }
      stateRef.current = next;
      setState(next);
    },
    []
  );

  const sliderBaseRef = useRef<EditState | null>(null);
  const beginSlider = useCallback(() => {
    if (!sliderBaseRef.current) sliderBaseRef.current = cloneState(stateRef.current);
  }, []);
  const endSlider = useCallback(() => {
    const base = sliderBaseRef.current;
    sliderBaseRef.current = null;
    if (!base) return;
    if (sameState(base, stateRef.current)) return;
    setHistory((h) => [...h.slice(-49), base]);
    setFuture([]);
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setFuture((f) => [...f, cloneState(stateRef.current)]);
      stateRef.current = prev;
      setState(prev);
      return h.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[f.length - 1];
      setHistory((h) => [...h, cloneState(stateRef.current)]);
      stateRef.current = next;
      setState(next);
      return f.slice(0, -1);
    });
  }, []);

  const reset = useCallback(() => {
    apply({ ...cloneState(EMPTY_STATE), cropEditing: false });
  }, [apply]);

  /** 离开/导出前把"框好了但还没按 Enter"的裁剪落地，避免所见与所得不一致。 */
  const commitPending = useCallback(() => {
    const s = stateRef.current;
    if (s.cropEditing && !isFullRect(s.cropRect)) {
      const next = { ...s, cropEditing: false, cropCommitted: true };
      stateRef.current = next;
      setState(next);
    }
  }, []);

  /* ---------------- 旋转 / 翻转 ---------------- */

  const rotate = useCallback(
    (delta: number) => {
      apply((p) => ({
        ...p,
        orientDeg: ((p.orientDeg + delta) % 360 + 360) % 360,
        cropRect: transformRect(p.cropRect, ((delta % 360) + 360) % 360, false),
      }));
    },
    [apply]
  );

  const flip = useCallback(() => {
    apply((p) => ({
      ...p,
      orientFlip: !p.orientFlip,
      cropRect: transformRect(p.cropRect, 0, true),
    }));
  }, [apply]);

  /* ---------------- 裁剪 ---------------- */

  const ratioOf = useCallback(
    (id: RatioId): number | null => {
      if (id === "free") return null;
      const ratio = RATIO_VALUE[id];
      if (!nat || !nat.w || !nat.h) return ratio;
      // 归一化坐标里的 w/h 与像素比例差一个画面宽高比。
      return ratio * (nat.h / nat.w);
    },
    [nat]
  );

  const pickRatio = useCallback(
    (id: RatioId) => {
      const q = ratioOf(id);
      if (q == null) {
        apply({ cropAspect: id });
        return;
      }
      let w = 1;
      let h = 1 / q;
      if (h > 1) {
        h = 1;
        w = q;
      }
      const rect = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
      apply({ cropAspect: id, cropRect: rect, cropEditing: true, cropCommitted: true });
    },
    [apply, ratioOf]
  );

  const enterCrop = useCallback(() => {
    const s = stateRef.current;
    if (s.cropEditing) {
      apply({ cropEditing: false });
      return;
    }
    cropBaseRef.current = s.cropCommitted ? { ...s.cropRect } : null;
    apply({ cropEditing: true });
  }, [apply]);

  const onCropPointerDown = (ev: ReactPointerEvent<HTMLElement>, handle: Handle) => {
    if (ev.button !== 0 || !nat) return;
    ev.preventDefault();
    ev.stopPropagation();
    const frame = ev.currentTarget.closest(".e-frame") as HTMLElement | null;
    const r = frame?.getBoundingClientRect();
    if (!r) return;
    const s = stateRef.current;
    if (!cropBaseRef.current) cropBaseRef.current = { ...s.cropRect };
    dragRef.current = {
      handle,
      startX: ev.clientX,
      startY: ev.clientY,
      rect: { ...s.cropRect },
      base: cloneState(s),
      frame: { w: r.width, h: r.height },
    };
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
  };

  useEffect(() => {
    const move = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const d = dragRef.current;
      const dx = (ev.clientX - d.startX) / d.frame.w;
      const dy = (ev.clientY - d.startY) / d.frame.h;
      const q = ratioOf(stateRef.current.cropAspect);
      let r: CropRect;
      if (d.handle === "move") {
        r = {
          ...d.rect,
          x: clamp(d.rect.x + dx, 0, 1 - d.rect.w),
          y: clamp(d.rect.y + dy, 0, 1 - d.rect.h),
        };
      } else {
        r = resizeCrop(d.rect, d.handle, dx, dy, q);
      }
      const next = { ...stateRef.current, cropRect: r, cropCommitted: true };
      stateRef.current = next;
      setState(next);
    };
    const up = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      if (!sameState(d.base, stateRef.current)) {
        setHistory((h) => [...h.slice(-49), d.base]);
        setFuture([]);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [ratioOf]);

  /* ---------------- 导出 ---------------- */

  const doExport = useCallback(async () => {
    if (!path || busy) return;
    commitPending();
    setBusy(true);
    try {
      const info = await exportEdits(path, stateRef.current);
      if (info.mock) {
        showToast("演示模式：导出未写入磁盘");
      } else {
        showToast(
          `已导出 ${info.path.split(/[\\/]/).pop()} · ${info.width}×${info.height}`
        );
        onExported?.();
      }
    } catch (e) {
      showToast(`导出失败：${String(e)}`, true);
    } finally {
      setBusy(false);
    }
  }, [busy, commitPending, onExported, path, showToast]);

  /* ---------------- 翻页 ---------------- */

  const go = useCallback(
    (i: number) => {
      const next = clamp(i, 0, Math.max(0, items.length - 1));
      if (next === safeIndex) return;
      commitPending();
      void flush().finally(() => onIndexChange(next));
    },
    [commitPending, flush, items.length, onIndexChange, safeIndex]
  );

  /* ---------------- 键位（§10.4） ---------------- */

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (isComposing(ev) || isTextInput(ev.target)) return;
      const k = ev.key;
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod) {
        const low = k.toLowerCase();
        if (low === "z") {
          ev.preventDefault();
          if (ev.shiftKey) redo();
          else undo();
          return;
        }
        if (low === "y") {
          ev.preventDefault();
          redo();
          return;
        }
        if (low === "s") {
          ev.preventDefault();
          void doExport();
          return;
        }
        return;
      }
      switch (k) {
        case "[":
          ev.preventDefault();
          go(safeIndex - 1);
          return;
        case "]":
          ev.preventDefault();
          go(safeIndex + 1);
          return;
        case "r":
        case "R":
          ev.preventDefault();
          rotate(ev.shiftKey ? -90 : 90);
          return;
        case "c":
        case "C":
          ev.preventDefault();
          enterCrop();
          return;
        case "Enter":
          ev.preventDefault();
          apply({ cropEditing: false, cropCommitted: true });
          return;
        case "Escape":
          ev.preventDefault();
          if (stateRef.current.cropEditing) {
            // 退出裁剪不等于确认：有已确认矩形就退回它，没有就留空。
            const base = cropBaseRef.current;
            cropBaseRef.current = null;
            apply({ cropEditing: false, cropRect: base ?? DEFAULT_RECT });
            return;
          }
          commitPending();
          void flush().finally(onClose);
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [apply, commitPending, doExport, enterCrop, flush, go, onClose, redo, rotate, safeIndex, undo]);

  /* ---------------- 渲染 ---------------- */

  if (!item) return null;

  const scale = nat
    ? Math.min((canvas.w - 64) / nat.w, (canvas.h - 64) / nat.h, 1)
    : 1;
  const frameW = nat ? Math.max(1, Math.round(nat.w * scale)) : 1;
  const frameH = nat ? Math.max(1, Math.round(nat.h * scale)) : 1;
  const frameStyle: CSSProperties = { width: frameW, height: frameH };

  const cropStyle: CSSProperties = {
    left: `${state.cropRect.x * 100}%`,
    top: `${state.cropRect.y * 100}%`,
    width: `${state.cropRect.w * 100}%`,
    height: `${state.cropRect.h * 100}%`,
  };

  const imgStyle: CSSProperties = preview?.mock ? { filter: mockFilterCss(state) } : {};

  const rows = stackRows(state);
  // 计数按"操作栈里启用的行"算；裁剪框还在编辑时也算一步（与设计稿的计数口径一致）。
  const count = rows.filter((r) => !state.disabled.includes(r.name)).length;
  const editedLabel = stale ? "原图在保存后被修改 · 调整仍按旧版本" : "";

  return (
    <div className="overlay editor" data-screen="edit">
      <div className="v-top floatbar">
        <button
          className="ibtn"
          title="返回看图"
          data-tip=""
          onClick={() => {
            commitPending();
            void flush().finally(onBackToViewer);
          }}
        >
          <Icon id="i-back" />
          <span className="tip tip-l">返回看图</span>
        </button>
        <span className="fb-title" title={item.name}>
          {item.name}
        </span>
        <span className="fb-count">
          {safeIndex + 1} / {items.length}
        </span>
        <div className="fb-sep" />
        <span className="fb-count">编辑栈 v1 · {count} 个操作</span>
        <div className="fb-spacer" />
        <button className="ibtn" title="上一张 ( [ )" onClick={() => go(safeIndex - 1)}>
          <Icon id="i-chev-left" />
        </button>
        <button className="ibtn" title="下一张 ( ] )" onClick={() => go(safeIndex + 1)}>
          <Icon id="i-chev-right" />
        </button>
        <div className="fb-sep" />
        <button
          className="ibtn"
          title="关闭"
          onClick={() => {
            commitPending();
            void flush().finally(onClose);
          }}
        >
          <Icon id="i-x" />
        </button>
      </div>

      <div className="e-body">
        <div className="e-canvas" ref={canvasRef}>
          <div className="e-frame" style={frameStyle}>
            {preview ? (
              <img
                ref={probeImage}
                src={preview.url}
                alt={item.name}
                draggable={false}
                style={imgStyle}
                onLoad={(e) => probeImage(e.currentTarget)}
              />
            ) : null}
            {state.cropEditing ? (
              <div
                className="crop edit-crop"
                style={cropStyle}
                onPointerDown={(e) => onCropPointerDown(e, "move")}
              >
                <i className="v1" />
                <i className="v2" />
                <i className="h1" />
                <i className="h2" />
                {(["g1", "g2", "g3", "g4"] as const).map((g) => (
                  <i
                    key={g}
                    className={`g ${g}`}
                    onPointerDown={(e) => onCropPointerDown(e, g)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <aside className="e-panel">
          <div className="panel-h">
            <b>基础调整</b>
            <Icon id="i-more" size="sm" />
          </div>

          <div className="insp-title" style={{ marginTop: 0 }}>
            <span>旋转</span>
          </div>
          <div className="tool-row">
            <button className="ibtn" title="逆时针 90° (⇧R)" onClick={() => rotate(-90)}>
              <Icon id="i-rot-ccw" />
            </button>
            <button className="ibtn" title="顺时针 90° (R)" onClick={() => rotate(90)}>
              <Icon id="i-rot-cw" />
            </button>
            <button className="ibtn" title="水平翻转" onClick={flip}>
              <Icon id="i-flip" />
            </button>
            <span className="hint" style={{ margin: "0 0 0 auto" }}>
              纯元数据
            </span>
          </div>

          <div className="insp-title">
            <span>裁剪</span>
            <span className="hint" style={{ margin: 0 }}>
              {state.cropEditing ? "Enter 确认" : "C 重新裁剪"}
            </span>
          </div>
          <div className="ratio-row">
            {RATIOS.map((r) => (
              <button
                key={r}
                className={`ratio${state.cropAspect === r ? " on" : ""}`}
                onClick={() => pickRatio(r)}
              >
                {r === "free" ? "自由" : r}
              </button>
            ))}
          </div>

          <div className="insp-title">
            <span>曝光与色彩</span>
          </div>
          <Slider
            label="曝光"
            value={state.exposure}
            display={formatEv(state.exposure)}
            onBegin={beginSlider}
            onChange={(v) => apply({ exposure: v }, false)}
            onEnd={endSlider}
          />
          <Slider
            label="对比度"
            value={state.contrast}
            display={signed(state.contrast)}
            onBegin={beginSlider}
            onChange={(v) => apply({ contrast: v }, false)}
            onEnd={endSlider}
          />
          <Slider
            label="饱和度"
            value={state.saturation}
            display={signed(state.saturation)}
            onBegin={beginSlider}
            onChange={(v) => apply({ saturation: v }, false)}
            onEnd={endSlider}
          />
          <Slider
            label="锐化"
            value={state.sharpen}
            display={(state.sharpen / 100).toFixed(2)}
            onBegin={beginSlider}
            onChange={(v) => apply({ sharpen: v }, false)}
            onEnd={endSlider}
          />
          <div className="hint">
            滑杆只写入编辑栈，原图字节不变。预览基于 2048px 代理，导出时按原图重放同一组参数。
          </div>
          {editedLabel ? (
            <div className="hint" style={{ color: "var(--ds-color-warn)" }}>
              {editedLabel}
            </div>
          ) : null}

          <div className="insp-title">
            <span>操作栈</span>
            <span className="hint" style={{ margin: 0 }}>
              {count} 步 · 可随时移除
            </span>
          </div>
          <div className="ostack">
            {rows.length === 0 ? (
              <div className="op-row">
                <span className="op-n">—</span>
                <span className="op-k">还没有调整</span>
                <span className="op-v" />
              </div>
            ) : (
              rows.map((row, i) => (
                <div
                  key={row.name}
                  className={`op-row${state.disabled.includes(row.name) ? " off" : ""}`}
                >
                  <span className="op-n">{i + 1}</span>
                  <span className="op-k">{row.label}</span>
                  <span className="op-v">{row.value}</span>
                  <button
                    className="op-x"
                    title={state.disabled.includes(row.name) ? "恢复此步" : "移除此步"}
                    onClick={() =>
                      apply((p) => ({
                        ...p,
                        disabled: p.disabled.includes(row.name)
                          ? p.disabled.filter((n) => n !== row.name)
                          : [...p.disabled, row.name],
                      }))
                    }
                  >
                    <Icon id={state.disabled.includes(row.name) ? "i-reset" : "i-x"} size="xs" />
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>

      <div className="e-bar">
        <span className="e-note">
          <Icon id="i-lock" size="sm" />
          非破坏性编辑 · 原图未修改
        </span>
        <div className="fb-spacer" />
        <button className="btn quiet" onClick={reset} disabled={history.length === 0 && count === 0}>
          <Icon id="i-reset" size="sm" />
          重置
        </button>
        <button className="btn quiet" onClick={undo} disabled={history.length === 0}>
          <Icon id="i-undo" size="sm" />
          撤销
        </button>
        <button className="btn solid" onClick={() => void doExport()} disabled={busy}>
          <Icon id="i-export" size="sm" />
          导出副本
        </button>
      </div>

      <Toast data={toast} onDone={() => setToast(null)} />
    </div>
  );
}

/* ---------------- 小组件与纯函数 ---------------- */

function Slider({
  label,
  value,
  display,
  onBegin,
  onChange,
  onEnd,
}: {
  label: string;
  value: number;
  display: string;
  onBegin: () => void;
  onChange: (v: number) => void;
  onEnd: () => void;
}) {
  return (
    <div className="slider-block">
      <div className="slider-top">
        <span>{label}</span>
        <b>{display}</b>
      </div>
      <input
        className="lr"
        style={{ width: "100%" }}
        type="range"
        min={label === "锐化" ? 0 : -100}
        max={100}
        value={value}
        onPointerDown={onBegin}
        onPointerUp={onEnd}
        onKeyDown={onBegin}
        onKeyUp={onEnd}
        onBlur={onEnd}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
      />
    </div>
  );
}

const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);
const formatEv = (v: number) =>
  `${v >= 0 ? "+" : "−"}${Math.abs(v / 100).toFixed(2)} EV`;

function mockFilterCss(s: EditState): string {
  return `brightness(${Math.pow(2, s.exposure / 100).toFixed(3)}) contrast(${(
    1 +
    s.contrast / 100
  ).toFixed(3)}) saturate(${(1 + s.saturation / 100).toFixed(3)})`;
}

interface Row {
  name: OpName;
  label: string;
  value: string;
}

/** 操作栈显示所有"有内容"的步骤，包括被停用的——停用只是不参与渲染。 */
function stackRows(s: EditState): Row[] {
  const rows: Row[] = [];
  const deg = ((s.orientDeg % 360) + 360) % 360;
  if (deg !== 0 || s.orientFlip) {
    rows.push({
      name: "orient",
      label: s.orientFlip ? "旋转 · 翻转" : "旋转",
      value: [deg ? `${deg}° CW` : null, s.orientFlip ? "翻转" : null]
        .filter(Boolean)
        .join(" · "),
    });
  }
  if (s.cropCommitted || s.cropEditing) {
    const pct = Math.round(s.cropRect.w * s.cropRect.h * 100);
    if (!isFullRect(s.cropRect)) {
      rows.push({
        name: "crop",
        label: "裁剪",
        value: `${s.cropAspect === "free" ? "自由" : s.cropAspect} · ${pct}%`,
      });
    }
  }
  if (s.exposure !== 0) {
    rows.push({ name: "exposure", label: "曝光", value: formatEv(s.exposure) });
  }
  if (s.contrast !== 0) {
    rows.push({ name: "contrast", label: "对比度", value: signed(s.contrast) });
  }
  if (s.saturation !== 0) {
    rows.push({ name: "saturation", label: "饱和度", value: signed(s.saturation) });
  }
  if (s.sharpen !== 0) {
    rows.push({ name: "sharpen", label: "锐化", value: (s.sharpen / 100).toFixed(2) });
  }
  return rows;
}

/**
 * 拖动裁剪框：free 时自由改边；锁比例时以对角为锚点，按指针较大的方向定尺寸，
 * 再夹到画布边界内。归一化坐标里 `w/h = 像素比例 × 画面高/宽`。
 */
export function resizeCrop(
  rect: CropRect,
  handle: Exclude<Handle, "move">,
  dx: number,
  dy: number,
  q: number | null
): CropRect {
  const x1 = clamp(rect.x + (handle === "g1" || handle === "g3" ? dx : 0), 0, 1);
  const x2 = clamp(
    rect.x + rect.w + (handle === "g2" || handle === "g4" ? dx : 0),
    x1 + MIN_CROP,
    1
  );
  const y1 = clamp(rect.y + (handle === "g1" || handle === "g2" ? dy : 0), 0, 1);
  const y2 = clamp(
    rect.y + rect.h + (handle === "g3" || handle === "g4" ? dy : 0),
    y1 + MIN_CROP,
    1
  );
  let w = Math.max(MIN_CROP, x2 - x1);
  let h = Math.max(MIN_CROP, y2 - y1);
  let x = x1;
  let y = y1;

  if (q != null) {
    // 锚点：被拖动角点的对角。
    const ax = handle === "g1" || handle === "g3" ? x2 : x1;
    const ay = handle === "g1" || handle === "g2" ? y2 : y1;
    const dirX = handle === "g1" || handle === "g3" ? -1 : 1;
    const dirY = handle === "g1" || handle === "g2" ? -1 : 1;
    if (w / h > q) h = w / q;
    else w = h * q;
    const maxW = dirX < 0 ? ax : 1 - ax;
    const maxH = dirY < 0 ? ay : 1 - ay;
    const k = Math.min(1, maxW / w, maxH / h);
    w = Math.max(MIN_CROP, w * k);
    h = Math.max(MIN_CROP, h * k);
    x = dirX < 0 ? ax - w : ax;
    y = dirY < 0 ? ay - h : ay;
  }
  return { x: clamp(x, 0, 1 - w), y: clamp(y, 0, 1 - h), w, h };
}
