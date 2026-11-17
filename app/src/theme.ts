// 亮/暗主题：深为默认（看图主场景），可手动切，可跟随系统。
// 持久化：localStorage 存 "auto" | "light" | "dark"；"auto" 跟随系统。

export type ThemePref = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const KEY = "albumio.theme";

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "auto" || v === "light" || v === "dark") return v;
  } catch {
    /* 隐私模式等场景 localStorage 不可用 */
  }
  return "auto";
}

function writePref(p: ThemePref): void {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* 静默失败 */
  }
}

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** 给 <html> 设 data-theme 与 color-scheme，整站样式全靠它切换。 */
function apply(resolved: ResolvedTheme): void {
  const html = document.documentElement;
  html.setAttribute("data-theme", resolved);
  // color-scheme 让浏览器原生控件（滚动条、input、对话框）也走对主题。
  html.style.colorScheme = resolved;
}

/** 启动时立即应用一次（在 React 挂载之前），避免闪一下默认深色。 */
export function hydrateTheme(): ThemePref {
  const pref = readPref();
  const resolved = pref === "auto" ? systemTheme() : pref;
  apply(resolved);
  return pref;
}

import { useEffect, useState, useCallback } from "react";

/**
 * 返回 [当前偏好, 设置偏好, 已解析的实际主题]。
 * 自动跟随系统（偏好="auto" 且系统变 → 自动切）。
 */
export function useTheme(): [ThemePref, (p: ThemePref) => void, ResolvedTheme] {
  const [pref, setPrefState] = useState<ThemePref>(() => readPref());
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    pref === "auto" ? systemTheme() : pref
  );

  // 应用到 DOM + 监听系统变化（只有偏好=auto 时才跟着系统转）。
  useEffect(() => {
    const recompute = () => {
      const r = pref === "auto" ? systemTheme() : pref;
      setResolved(r);
      apply(r);
    };
    recompute();

    if (pref === "auto" && typeof window !== "undefined") {
      const mql = window.matchMedia("(prefers-color-scheme: light)");
      const onChange = () => recompute();
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
  }, [pref]);

  const setPref = useCallback((p: ThemePref) => {
    writePref(p);
    setPrefState(p);
  }, []);

  return [pref, setPref, resolved];
}
