/**
 * 网格（04-项目计划 M2 / 屏 1 上半）+ 时间线（M3）。
 *
 * 虚拟滚动：只挂可视行 ±2 行（`docs/spike/S5.md` 实测 1 万项 60fps）。
 * 几何全部对齐 `design/index.html`：格宽五档 96/128/160/192/256、
 * 间距 8/12/12/16/16、内边距 12、文件名条 20；时间线分组头 32（上 12 / 下 6 + 行高 14）。
 *
 * 时间线模式行高不统一（分组头 32 + 网格行），所以按"行模型"统一排：
 * 头部与网格行都按绝对位置摆放，粘性头用一条 sticky 覆盖层还原（§11.7）。
 */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { Entry } from "../data/source";
import { Icon } from "../icons";

export const CELLS = [96, 128, 160, 192, 256];
export const GAPS = [8, 12, 12, 16, 16];
const PAD = 12;
const CAPTION = 20;
const HEADER_H = 32;
const OVERSCAN = 2;

export interface ThumbState {
  l0?: string;
  l1?: string;
  failed?: boolean;
}

export interface TimelineGroup {
  key: string;
  label: string;
  inferred: number;
  items: Entry[];
}

export interface GridProps {
  /** 目录视图的条目；时间线视图传扁平化后的同序条目（键盘与连选都按它走）。 */
  items: Entry[];
  /** 有时间线分组时进入分组渲染；空数组或 undefined 表示普通网格。 */
  groups?: TimelineGroup[];
  /** 视图标识（`dir|view`）：切换视图时各自记住滚动位置。 */
  scrollKey: string;
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

interface Line {
  kind: "header" | "row";
  top: number;
  height: number;
  /** 扁平条目下标区间 [from, to)，分组头为 0 长度。 */
  from: number;
  to: number;
  /** 组内下标区间，用于从分组条目里切片。 */
  localFrom: number;
  localTo: number;
  groupIndex: number;
  items: Entry[];
}

export default function Grid({
  items,
  groups,
  scrollKey,
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
  const [viewportH, setViewportH] = useState(0);
  const [range, setRange] = useState({ first: 0, last: 0, active: 0, pin: false });
  const rafRef = useRef(0);
  // 每个 key（dir|view）各自记住滚动位置；切换时恢复（验收：切视图不丢选中与滚动）。
  const scrollMemo = useRef(new Map<string, number>());
  // 正在恢复时不要把"内容高度变化导致的钳制值"记进旧 key。
  const savedKey = useRef<string | null>(scrollKey);

  const cell = CELLS[cellIdx - 1];
  const gap = GAPS[cellIdx - 1];
  const rowH = cell + CAPTION + gap;
  const columns = Math.max(1, Math.floor((width - PAD * 2 + gap) / (cell + gap)));
  const grouped = !!groups && groups.length > 0;

  const layout = useMemo(() => {
    const lines: Line[] = [];
    const rowTop: number[] = [];
    let top = PAD;
    let flat = 0;
    const source: Array<{ items: Entry[]; groupIndex: number }> = grouped
      ? groups!.map((g, gi) => ({ items: g.items, groupIndex: gi }))
      : [{ items, groupIndex: 0 }];
    for (const s of source) {
      if (grouped) {
        lines.push({
          kind: "header",
          top,
          height: HEADER_H,
          from: flat,
          to: flat,
          localFrom: 0,
          localTo: 0,
          groupIndex: s.groupIndex,
          items: [],
        });
        top += HEADER_H;
      }
      for (let r = 0; r * columns < s.items.length; r++) {
        const from = r * columns;
        const to = Math.min(s.items.length, from + columns);
        lines.push({
          kind: "row",
          top,
          height: rowH,
          from: flat + from,
          to: flat + to,
          localFrom: from,
          localTo: to,
          groupIndex: s.groupIndex,
          items: s.items,
        });
        for (let i = from; i < to; i++) rowTop[flat + i] = top;
        top += rowH;
      }
      flat += s.items.length;
    }
    const totalH = items.length === 0 ? 0 : top - gap + PAD;
    return { lines, rowTop, totalH };
  }, [grouped, groups, items, columns, rowH, gap]);

  const { lines, rowTop, totalH } = layout;

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

  // 只在"跨行/跨组"时改状态：同一行内滚动不触发重渲染（S5 的帧预算靠这个守住）。
  const syncRows = () => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const minY = top - OVERSCAN * rowH;
    const maxY = top + el.clientHeight + OVERSCAN * rowH;
    let first = 0;
    while (first < lines.length - 1 && lines[first].top + lines[first].height < minY) first++;
    let last = first;
    while (last < lines.length - 1 && lines[last + 1].top <= maxY) last++;
    // 粘性头：取最后一个已经滚到视口顶的组；分组头本身已滚出视口顶才显示覆盖层，
    // 否则会和行内那个头的文字叠在一起（§11.7）。
    let active = 0;
    let pin = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].kind === "header" && lines[i].top <= top + 1) {
        active = lines[i].groupIndex;
        pin = lines[i].top < top;
      }
    }
    setRange((prev) =>
      prev.first === first && prev.last === last && prev.active === active && prev.pin === pin
        ? prev
        : { first, last, active, pin }
    );
  };

  const onScroll = () => {
    // 位置同步记，不走 rAF：视图切换时的钳制与恢复之间不能丢这一笔。
    const el = scrollRef.current;
    if (el && savedKey.current === scrollKey) scrollMemo.current.set(scrollKey, el.scrollTop);
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      syncRows();
    });
  };

  useEffect(() => {
    syncRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, rowH, width, viewportH]);

  // 视图切换时各自恢复滚动位置（验收：切视图不丢选中与滚动）。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    savedKey.current = null; // 钳制过程不记账
    const want = scrollMemo.current.get(scrollKey) ?? 0;
    if (Math.abs(el.scrollTop - want) > 1) el.scrollTop = want;
    savedKey.current = scrollKey;
    syncRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    []
  );

  useEffect(() => {
    if (!width || items.length === 0) return;
    const firstLine = lines[range.first];
    const lastLine = lines[range.last];
    if (!firstLine || !lastLine) return;
    const pageRows = Math.max(1, Math.floor((viewportH - PAD * 2) / rowH));
    onVisibleRange(firstLine.from, lastLine.to, columns, pageRows);
  }, [range, lines, columns, width, viewportH, rowH, items.length, onVisibleRange]);

  // 键盘移动后把当前项滚进视野（虚拟列表里元素不一定已挂载，用几何算）。
  // 只在"当前项真的换了"时动滚动：布局重建（切视图/改格宽）不能把用户的滚动位置顶回去。
  const currentIndex = current ? items.findIndex((x) => x.path === current) : -1;
  const lastCurrent = useRef<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !current || current === lastCurrent.current || currentIndex < 0 || !width) return;
    lastCurrent.current = current;
    const top = rowTop[currentIndex];
    if (top === undefined) return;
    const bottom = top + rowH;
    if (top < el.scrollTop) el.scrollTop = Math.max(0, top - PAD);
    else if (bottom > el.scrollTop + el.clientHeight)
      el.scrollTop = bottom - el.clientHeight + PAD;
  }, [current, currentIndex, rowTop, rowH, width]);

  const pinned = grouped ? groups![range.active] : undefined;
  const visibleLines = lines.slice(range.first, range.last + 1);

  return (
    <div className="stage" ref={scrollRef} onScroll={onScroll} tabIndex={-1}>
      <div
        className={`grid${grouped ? " tl" : ""}`}
        style={{ height: totalH, "--lv-cell": `${cell}px` } as CSSProperties}
      >
        {pinned && range.pin && (
          <h3 className="tl-h tl-pin" style={{ top: 0 }} aria-hidden="true">
            {pinned.label} <em>{pinned.items.length} 项</em>
            {pinned.inferred > 0 && <span className="tl-tag">推断 {pinned.inferred}</span>}
          </h3>
        )}
        {visibleLines.map((line) => {
          if (line.kind === "header") {
            const g = groups![line.groupIndex];
            return (
              <h3 className="tl-h" key={`h:${g.key}`} style={{ top: line.top }}>
                {g.label} <em>{g.items.length} 项</em>
                {g.inferred > 0 && <span className="tl-tag">推断 {g.inferred}</span>}
              </h3>
            );
          }
          return (
            <div
              className="grid-row"
              key={`r:${line.groupIndex}:${line.localFrom}`}
              style={{ top: line.top, height: line.height, gap }}
            >
              {line.items.slice(line.localFrom, line.localTo).map((item, k) => {
                const index = line.from + k;
                const on = selected.has(item.path);
                const order =
                  on && selected.size > 1 ? [...selected].indexOf(item.path) + 1 : 0;
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
