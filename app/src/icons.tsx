/* 图标精灵：几何与 design/index.html 的 <symbol> 完全一致（G1）。
   新增图标时从设计稿复制 symbol，不得自己画。 */

import type { CSSProperties, ReactNode } from "react";

const ICONS: Record<string, ReactNode> = {
  "i-chev-left": <path d="M15 18l-6-6 6-6" />,
  "i-chev-right": <path d="M9 6l6 6-6 6" />,
  "i-chev-down": <path d="M6 9l6 6 6-6" />,
  "i-folder": <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  "i-up": <path d="M12 19V5M5 12l7-7 7 7" />,
  "i-grid": <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />,
  "i-timeline": (
    <>
      <path d="M4 6h16M4 12h11M4 18h14" />
      <circle cx="19" cy="12" r="1.6" />
    </>
  ),
  "i-sort": <path d="M4 7h10M4 12h7M4 17h4M18 7v10M15 14l3 3 3-3" />,
  "i-image": (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.4" />
      <path d="M21 16l-5-5-4 4-2-2-5 5" />
    </>
  ),
  "i-search": (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </>
  ),
  "i-layers": (
    <>
      <path d="M12 3.5l8 4.2-8 4.2-8-4.2z" />
      <path d="M4 12.2l8 4.2 8-4.2M4 16.3l8 4.2 8-4.2" />
    </>
  ),
  "i-sliders": (
    <>
      <path d="M4 8h9M18 8h2M4 16h3M12 16h8" />
      <circle cx="15.5" cy="8" r="2" />
      <circle cx="9.5" cy="16" r="2" />
    </>
  ),
  "i-maximize": (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 9.5h16" />
    </>
  ),
  "i-fullscreen": <path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" />,
  "i-panel-right": (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  "i-star": <path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.8l5.9-.9z" />,
  "i-heart": <path d="M12 20s-7-4.4-7-9a4 4 0 017-2.6A4 4 0 0119 11c0 4.6-7 9-7 9z" />,
  "i-minus": <path d="M5 12h14" />,
  "i-x": <path d="M6 6l12 12M18 6L6 18" />,
  // 屏 2（M5）：几何从 design/index.html 的 symbol 逐个复制。
  "i-back": <path d="M19 12H5M12 19l-7-7 7-7" />,
  "i-info": (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11.5v5M12 8.2v.4" />
    </>
  ),
  "i-zoom-in": (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M11 8.5v5M8.5 11h5M20 20l-4.2-4.2" />
    </>
  ),
  "i-zoom-out": (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M8.5 11h5M20 20l-4.2-4.2" />
    </>
  ),
  "i-fit": (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M9 10l-2 2 2 2M15 10l2 2-2 2" />
    </>
  ),
  "i-actual": (
    <>
      <path d="M4 8V4h4M20 16v4h-4M20 8V4h-4M4 16v4h4" />
      <path d="M9 12h6" />
    </>
  ),
  "i-film": (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4" />
    </>
  ),
  // 屏 4（M7）：勾选框与开始按钮，几何从设计稿 symbol 复制。
  "i-check": <path d="M4.5 12.5l4.5 4.5L19.5 6.5" />,
  "i-play": <path d="M8 5.5l10 6.5-10 6.5z" />,
  // 屏 3（M6）：同样从设计稿 symbol 复制。
  "i-crop": <path d="M6 3v13a2 2 0 002 2h13M3 6h13a2 2 0 012 2v13" />,
  "i-rot-cw": <path d="M20 12a8 8 0 11-2.4-5.7M20 4v5h-5" />,
  "i-rot-ccw": <path d="M4 12a8 8 0 102.4-5.7M4 4v5h5" />,
  "i-flip": (
    <>
      <path d="M12 4v16" strokeDasharray="2 2" />
      <path d="M8 7L4 12l4 5zM16 7l4 5-4 5z" />
    </>
  ),
  "i-more": (
    <>
      <circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  "i-undo": (
    <>
      <path d="M9 7L4 12l5 5" />
      <path d="M4 12h9a6 6 0 010 12" />
    </>
  ),
  "i-reset": (
    <>
      <path d="M4 12a8 8 0 0113.7-5.7M20 12a8 8 0 01-13.7 5.7" />
      <path d="M18 3v4h-4M6 21v-4h4" />
    </>
  ),
  "i-export": (
    <>
      <path d="M12 15V4M8 8l4-4 4 4" />
      <path d="M5 14v4a2 2 0 002 2h10a2 2 0 002-2v-4" />
    </>
  ),
  "i-lock": (
    <>
      <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" />
    </>
  ),
  // 设置：Material Symbols 的 gear（24×24）。
  "i-gear": (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.14 12.94a7.8 7.8 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.61-.22l-2.39.96a7.3 7.3 0 00-1.63-.94l-.36-2.54a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.5.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 00-.61.22L2.71 8.84a.5.5 0 00.12.64l2.03 1.58a7.8 7.8 0 000 1.88l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32a.5.5 0 00.61.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54a.5.5 0 00.5.42h3.84a.5.5 0 00.5-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96a.5.5 0 00.61-.22l1.92-3.32a.5.5 0 00-.12-.64z" />
    </>
  ),
};

export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      {Object.entries(ICONS).map(([id, node]) => (
        <symbol key={id} id={id} viewBox="0 0 24 24">
          {node}
        </symbol>
      ))}
    </svg>
  );
}

export function Icon({
  id,
  size,
  className,
  style,
}: {
  id: string;
  size?: "xs" | "sm" | "lg" | "xl";
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={["i", size ? `i-${size}` : "", className ?? ""].join(" ").trim()}
      style={style}
    >
      <use href={`#${id}`} />
    </svg>
  );
}
