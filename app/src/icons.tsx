/* 图标精灵：几何与 design/index.html 的 <symbol> 完全一致（G1）。
   新增图标时从设计稿复制 symbol，不得自己画。 */

import type { ReactNode } from "react";

const ICONS: Record<string, ReactNode> = {
  "i-chev-left": <path d="M15 18l-6-6 6-6" />,
  "i-chev-right": <path d="M9 6l6 6-6 6" />,
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
}: {
  id: string;
  size?: "xs" | "sm" | "lg" | "xl";
  className?: string;
}) {
  return (
    <svg className={["i", size ? `i-${size}` : "", className ?? ""].join(" ").trim()}>
      <use href={`#${id}`} />
    </svg>
  );
}
