/**
 * 网格（04-项目计划 M2 / 屏 1 上半）。
 *
 * 虚拟滚动：只挂可视行 ±2 行（`docs/spike/S5.md` 实测 1 万项 60fps）。
 * 几何全部对齐 `design/index.html`：格宽五档 96/128/160/192/256、
 * 间距 8/12/12/16/16、内边距 12、文件名条 20。
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Entry } from "../data/source";
import { Icon } from "../icons";

export const CELLS = [96, 128, 160, 192, 256];
export const GAPS = [8, 12, 12, 16, 16];
const PAD = 12;
const CAPTION = 20;
const OVERSCAN = 2;

export interface ThumbState {
  l0?: string;
  l1?: string;
  failed?: boolean;
}

export interface GridProps {
  items: Entry[];
  cellIdx: number;
  selected: Set<string>;
  current: string | null;
  thumbs: Map<string, ThumbState>;
  ratings: Map<string, number>;
  favorites: Set<string>;
  onPick: (path: string, opts: { additive: boolean; range: boolean }) => void;
  onRate: (path: string) => void;
  onFavorite: (path: string) => void;
  onOpen: (path: string) => void;
  onVisibleRange: (start: number, end: number, columns: number, pageRows: number) => void;
}

export default function Grid({
  items,
  cellIdx,
  selected,
  current,
  thumbs,
  ratings,
  favorites,
  onPick,
  onRate,
  onFavorite,
  onOpen,
  onVisibleRange,
}: GridProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [rowRange, setRowRange] = useState({ first: 0, last: 0 });
  const [viewportH, setViewportH] = useState(0);
  const rafRef = useRef(0);

  const cell = CELLS[cellIdx - 1];
  const gap = GAPS[cellIdx - 1];
  const rowH = cell + CAPTION + gap;
  const columns = Math.max(1, Math.floor((width - PAD * 2 + gap) / (cell + gap)));
  const rows = Math.max(1, Math.ceil(items.length / columns));
  const totalH = items.length === 0 ? 0 : PAD * 2 + rows * rowH - gap;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const apply = () => {
      setWidth(el.clientWidth);
      setViewportH(el.clientHeight);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const firstRow = rowRange.first;
  const lastRow = Math.min(rows - 1, Math.max(rowRange.last, firstRow));

  // 滚动只在"跨行"时才改状态：同一行内滚动不触发 React 重渲染（S5 的帧预算靠这个守住）。
  const syncRows = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const first = Math.max(0, Math.floor((top - PAD) / rowH) - OVERSCAN);
    const last = Math.min(
      rows - 1,
      Math.ceil((top + el.clientHeight - PAD) / rowH) + OVERSCAN
    );
    setRowRange((prev) => (prev.first === first && prev.last === last ? prev : { first, last }));
  };

  const onScroll = () => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      syncRows();
    });
  };

  useEffect(() => {
    syncRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowH, rows, width, viewportH]);

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  useEffect(() => {
    if (!width || items.length === 0) return;
    const start = Math.max(0, firstRow * columns);
    const end = Math.min(items.length, (lastRow + 1) * columns);
    const pageRows = Math.max(1, Math.floor((viewportH - PAD * 2) / rowH));
    onVisibleRange(start, end, columns, pageRows);
  }, [firstRow, lastRow, columns, width, viewportH, rowH, items.length, onVisibleRange]);

  // 键盘移动后把当前项滚进视野（虚拟列表里元素不一定已挂载，用几何算）。
  const currentIndex = current ? items.findIndex((x) => x.path === current) : -1;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || currentIndex < 0 || !width) return;
    const row = Math.floor(currentIndex / columns);
    const top = PAD + row * rowH;
    const bottom = top + rowH;
    if (top < el.scrollTop) el.scrollTop = Math.max(0, top - PAD);
    else if (bottom > el.scrollTop + el.clientHeight)
      el.scrollTop = bottom - el.clientHeight + PAD;
  }, [currentIndex, columns, rowH, width]);

  const visible: number[] = [];
  for (let r = firstRow; r <= lastRow; r++) visible.push(r);

  return (
    <div className="stage" ref={scrollRef} onScroll={onScroll}>
      <div
        className="grid"
        style={{ height: totalH, "--lv-cell": `${cell}px` } as CSSProperties}
      >
        {visible.map((r) => {
          const from = r * columns;
          const to = Math.min(items.length, from + columns);
          return (
            <div
              className="grid-row"
              key={r}
              style={{ top: PAD + r * rowH, height: rowH, gap }}
            >
              {items.slice(from, to).map((item, k) => {
                const index = from + k;
                const on = selected.has(item.path);
                const order = on && selected.size > 1 ? [...selected].indexOf(item.path) + 1 : 0;
                const thumb = thumbs.get(item.path);
                const rating = ratings.get(item.path) ?? 0;
                const fav = favorites.has(item.path);
                return (
                  <div
                    key={item.path}
                    className={`tile${on ? " sel" : ""}${current === item.path ? " cur" : ""}`}
                    data-index={index}
                    title={item.name}
                    onClick={(e) =>
                      onPick(item.path, {
                        additive: e.ctrlKey || e.metaKey,
                        range: e.shiftKey,
                      })
                    }
                    onDoubleClick={() => onOpen(item.path)}
                  >
                    <div className="tile-img">
                      {thumb?.l1 || thumb?.l0 ? (
                        <img src={thumb.l1 ?? thumb.l0} alt="" draggable={false} />
                      ) : null}
                      <span className="tile-badge" style={{ display: order ? "flex" : "none" }}>
                        {order || ""}
                      </span>
                      <div className="tile-acts">
                        <button
                          className={`act${rating > 0 ? " starred" : ""}`}
                          title={`评分 ${rating}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onRate(item.path);
                          }}
                        >
                          <Icon id="i-star" size="sm" />
                        </button>
                        <button
                          className={`act${fav ? " faved" : ""}`}
                          title={fav ? "取消收藏" : "收藏"}
                          onClick={(e) => {
                            e.stopPropagation();
                            onFavorite(item.path);
                          }}
                        >
                          <Icon id="i-heart" size="sm" />
                        </button>
                      </div>
                    </div>
                    <div className="tile-cap">{item.name}</div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
