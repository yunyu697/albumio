// 设置面板：齿轮按钮点开的 Popover，三项即时生效。
// 不做独立屏，不存"取消"；关掉 Popover 就是关掉。
import { useEffect, useRef } from "react";
import { Icon } from "../icons";
import type { ThemePref, ResolvedTheme } from "../theme";

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
  anchorRef: React.RefObject<HTMLButtonElement>;
}

const OPTIONS: { value: ThemePref; label: string; hint: string }[] = [
  { value: "auto", label: "跟随系统", hint: "系统亮暗切换时自动跟随" },
  { value: "light", label: "浅色", hint: "中性浅表面，画布恒深" },
  { value: "dark", label: "深色", hint: "默认，看图时最不抢眼" },
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
          {OPTIONS.map((opt) => {
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
    </div>
  );
}
