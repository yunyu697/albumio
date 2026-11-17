// 设置面板：标题栏齿轮按钮点开的 Popover，即时生效。
// 多 section，可滚动；关掉就是关掉，不存"取消"。
import { useEffect, useRef } from "react";
import { Icon } from "../icons";
import type { ThemePref, ResolvedTheme } from "../theme";
import type { SortMode } from "../data/source";

interface Props {
  open: boolean;
  onClose: () => void;
  themePref: ThemePref;
  setThemePref: (p: ThemePref) => void;
  resolvedTheme: ResolvedTheme;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  cellIdx: number;
  onCellIdxChange: (n: number) => void;
  view: "folder" | "timeline";
  onViewChange: (v: "folder" | "timeline") => void;
  sort: SortMode;
  onSortChange: (s: SortMode) => void;
  recursiveDepth: number;
  onRecursiveDepthChange: (d: number) => void;
  reopenLastDir: boolean;
  onReopenLastDirChange: (v: boolean) => void;
  anchorRef: React.RefObject<HTMLButtonElement>;
}

const THEME_OPTS: { value: ThemePref; label: string; hint: string }[] = [
  { value: "auto", label: "跟随系统", hint: "系统亮暗切换时自动跟随" },
  { value: "light", label: "浅色", hint: "中性浅表面，画布恒深" },
  { value: "dark", label: "深色", hint: "默认，看图时最不抢眼" },
];

const SORT_OPTS: { value: SortMode; label: string }[] = [
  { value: "nameAsc", label: "名称 · 升序" },
  { value: "folderThenName", label: "路径分组 · 名称" },
  { value: "nameDesc", label: "名称 · 降序" },
  { value: "mtimeDesc", label: "修改时间 · 新→旧" },
  { value: "sizeDesc", label: "文件大小 · 大→小" },
];

const REC_DEPTH_OPTS: { value: number; label: string }[] = [
  { value: 0, label: "不穿透" },
  { value: 2, label: "2 层深" },
  { value: 4, label: "4 层深" },
  { value: 6, label: "6 层深" },
];

const VIEW_OPTS: { value: "folder" | "timeline"; label: string }[] = [
  { value: "folder", label: "目录网格" },
  { value: "timeline", label: "时间线" },
];

export default function SettingsPopover({
  open,
  onClose,
  themePref,
  setThemePref,
  resolvedTheme,
  sidebarOpen,
  onToggleSidebar,
  inspectorOpen,
  onToggleInspector,
  cellIdx,
  onCellIdxChange,
  view,
  onViewChange,
  sort,
  onSortChange,
  recursiveDepth,
  onRecursiveDepthChange,
  reopenLastDir,
  onReopenLastDirChange,
  anchorRef,
}: Props) {
  const popRef = useRef<HTMLDivElement>(null);

  // 点外部 / Esc 关闭。
  useEffect(() => {
    if (!open) return;
    const onClick = (ev: MouseEvent) => {
      const pop = popRef.current;
      const anchor = anchorRef.current;
      if (pop && !pop.contains(ev.target as Node) && anchor && !anchor.contains(ev.target as Node)) {
        onClose();
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return (
    <div className="settings-pop" ref={popRef} role="dialog" aria-label="设置">
      <div className="sp-section">
        <div className="sp-title">外观</div>
        <div className="sp-theme-row">
          {THEME_OPTS.map((opt) => {
            const active = themePref === opt.value;
            const live = opt.value === "auto" ? `跟随系统（当前：${resolvedTheme === "light" ? "浅" : "深"}）` : null;
            return (
              <button
                key={opt.value}
                className={`sp-theme-btn${active ? " on" : ""}`}
                onClick={() => setThemePref(opt.value)}
                title={live ?? opt.hint}
              >
                <Icon id="i-check" size="xs" />
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="sp-section">
        <div className="sp-title">界面</div>
        <label className="sp-row">
          <span>侧边栏</span>
          <input type="checkbox" checked={sidebarOpen} onChange={onToggleSidebar} />
        </label>
        <label className="sp-row">
          <span>检查器</span>
          <input type="checkbox" checked={inspectorOpen} onChange={onToggleInspector} />
        </label>
      </div>

      <div className="sp-section">
        <div className="sp-title">默认视图</div>
        <div className="sp-row sp-row-col">
          <div className="sp-sub">网格尺寸</div>
          <input
            type="range"
            min={0}
            max={4}
            value={cellIdx}
            onChange={(e) => onCellIdxChange(Number(e.target.value))}
          />
          <span className="sp-range-label">{cellIdx + 1} / 5 档</span>
        </div>
        <label className="sp-row">
          <span>起始视图</span>
          <select value={view} onChange={(e) => onViewChange(e.target.value as "folder" | "timeline")}>
            {VIEW_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sp-row">
          <span>排序</span>
          <select value={sort} onChange={(e) => onSortChange(e.target.value as SortMode)}>
            {SORT_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sp-row">
          <span>穿透深度</span>
          <select value={recursiveDepth} onChange={(e) => onRecursiveDepthChange(Number(e.target.value))}>
            {REC_DEPTH_OPTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="sp-section">
        <div className="sp-title">启动</div>
        <label className="sp-row">
          <span>打开上次浏览的目录</span>
          <input type="checkbox" checked={reopenLastDir} onChange={(e) => onReopenLastDirChange(e.target.checked)} />
        </label>
      </div>
    </div>
  );
}
