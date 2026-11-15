/**
 * 屏 1 的网格浏览（04-项目计划 M2）。
 *
 * 数据路径（`docs/spike/S4.md`）：`albumio_list` 只 readdir → 立刻出格子 →
 * P0 可见区 / P1 预取 / P2 当前目录分批补 stat → L0 先上屏、L1 补位。
 * 键位按 02-设计规范 §10.2，输入态与 IME 组合期一律忽略（§10.6）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Grid, { CELLS, type ThumbState } from "../components/Grid";
import {
  PRIORITY,
  createScheduler,
  defaultDir,
  listDir,
  releaseThumb,
  thumbUrl,
  type Entry,
  type StatRow,
} from "../data/source";
import type { StatScheduler } from "../data/scheduler";
import { isComposing, isTextInput } from "../keys";

export interface GridStatus {
  dir: string;
  total: number;
  selected: number;
  knownBytes: number;
  statsComplete: boolean;
  cell: number;
  currentName: string | null;
  currentPath: string | null;
  currentSize: number | null;
  currentRating: number | null;
}

interface BrowseProps {
  cellIdx: number;
  onCellIdxChange: (n: number) => void;
  onStatus: (s: GridStatus) => void;
}

interface Range {
  start: number;
  end: number;
  columns: number;
  pageRows: number;
}

// L0 是"占位色块"，永远优先；L1 只在滚动停下后补，且单独限并发，
// 免得 256px 解码把 L0 的空槽占满、可见格子一直空着（实机 1 万项复现过）。
const THUMB_L0_CONCURRENCY = 4;
const THUMB_L1_CONCURRENCY = 2;
const THUMB_L1_IDLE_MS = 120;
// 缩略图状态只保留窗口附近的项：1 万项全留会把 blob URL 一直攥在手里。
const THUMB_STATE_MAX = 600;

export default function Browse({ cellIdx, onCellIdxChange, onStatus }: BrowseProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [dir, setDir] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [ratings, setRatings] = useState<Map<string, number>>(new Map());
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<Range>({ start: 0, end: 0, columns: 1, pageRows: 1 });
  const [thumbTick, setThumbTick] = useState(0);

  const generationRef = useRef(0);
  const schedulerRef = useRef<StatScheduler | null>(null);
  const statsRef = useRef<Map<string, StatRow>>(new Map());
  const requestedRef = useRef<Set<string>>(new Set());
  const thumbState = useRef<Map<string, ThumbState>>(new Map());
  const thumbQueue = useRef<Array<{ path: string; level: "l0" | "l1" }>>([]);
  const thumbInflight = useRef<Set<string>>(new Set());
  const thumbActiveL0 = useRef(0);
  const thumbActiveL1 = useRef(0);
  const lastScrollRef = useRef(0);
  const retryRef = useRef(0);
  const currentRef = useRef<string | null>(null);
  const entriesRef = useRef<Entry[]>([]);
  const selectedRef = useRef<Set<string>>(new Set());
  const rangeRef = useRef<Range>(range);
  const cellIdxRef = useRef(cellIdx);

  currentRef.current = current;
  entriesRef.current = entries;
  selectedRef.current = selected;
  rangeRef.current = range;
  cellIdxRef.current = cellIdx;

  if (!schedulerRef.current) schedulerRef.current = createScheduler();

  /* ---------------- 载入目录 ---------------- */

  useEffect(() => {
    void defaultDir().then((d) => setDir(d));
  }, []);

  // 滚动活跃度：缩略图调度用它决定"现在只补 L0 还是也能补 L1"。
  useEffect(() => {
    const onScroll = () => {
      lastScrollRef.current = performance.now();
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, []);

  useEffect(() => {
    if (!dir) return;
    let alive = true;
    void listDir(dir)
      .then((r) => {
        if (!alive) return;
        generationRef.current = r.generation;
        schedulerRef.current?.setGeneration(r.generation);
        statsRef.current = new Map();
        requestedRef.current = new Set();
        thumbState.current = new Map();
        thumbQueue.current = [];
        thumbInflight.current = new Set();
        thumbActiveL0.current = 0;
        thumbActiveL1.current = 0;
        lastScrollRef.current = 0;
        setEntries(r.entries);
        const first = r.entries[0]?.path ?? null;
        setCurrent(first);
        setSelected(first ? new Set([first]) : new Set());
        // P2：当前目录剩余项按 100 一批排队；P0/P1 随滚动插队。
        for (let i = 0; i < r.entries.length; i += 100) {
          const chunk = r.entries.slice(i, i + 100).map((e) => e.path);
          chunk.forEach((p) => requestedRef.current.add(p));
          void schedulerRef.current
            ?.request(chunk, PRIORITY.currentDir)
            .then((res) => applyStats(res.stats));
        }
      })
      .catch(() => {
        if (!alive) return;
        setEntries([]);
        setCurrent(null);
        setSelected(new Set());
      });
    return () => {
      alive = false;
    };
  }, [dir]);

  const applyStats = useCallback((rows: StatRow[]) => {
    if (rows.length === 0) return;
    const next = statsRef.current;
    for (const r of rows) next.set(r.path, r);
    // 复用同一个 tick 驱动重渲染（stat 与缩略图都只是"数据变了"）
    setThumbTick((t) => t + 1);
  }, []);

  /* ---------------- 可见区：P0/P1 stat + 缩略图 ---------------- */

  const onVisibleRange = useCallback(
    (start: number, end: number, columns: number, pageRows: number) => {
      setRange((prev) =>
        prev.start === start &&
        prev.end === end &&
        prev.columns === columns &&
        prev.pageRows === pageRows
          ? prev
          : { start, end, columns, pageRows }
      );
    },
    []
  );

  /** 丢掉窗口外的缩略图状态并归还 blob URL，避免 1 万项把内存攥住。 */
  const pruneThumbs = useCallback((wanted: Set<string>) => {
    if (thumbState.current.size <= THUMB_STATE_MAX) return;
    for (const [path, st] of thumbState.current) {
      if (thumbState.current.size <= THUMB_STATE_MAX) break;
      if (wanted.has(path)) continue;
      thumbState.current.delete(path);
      if (st.l0) releaseThumb(path, "l0", st.l0);
      if (st.l1) releaseThumb(path, "l1", st.l1);
    }
  }, []);

  const pumpThumbs = useCallback(() => {
    for (;;) {
      const queue = thumbQueue.current;
      if (queue.length === 0) return;
      const idle = performance.now() - lastScrollRef.current > THUMB_L1_IDLE_MS;
      const l0Idx = queue.findIndex((j) => j.level === "l0");
      const l0Room = thumbActiveL0.current < THUMB_L0_CONCURRENCY;
      const l1Room = idle && thumbActiveL1.current < THUMB_L1_CONCURRENCY;
      // L0 永远插在 L1 前面；L0 槽满时才借 L1 的空槽，滚动中不碰 L1。
      let idx = -1;
      if (l0Idx >= 0 && l0Room) idx = l0Idx;
      else if (l1Room) idx = queue.findIndex((j) => j.level === "l1");
      if (idx < 0) {
        if (!retryRef.current) {
          retryRef.current = window.setTimeout(() => {
            retryRef.current = 0;
            pumpThumbs();
          }, 150);
        }
        return;
      }
      const [job] = queue.splice(idx, 1);
      const key = `${job.path}|${job.level}`;
      if (thumbInflight.current.has(key)) continue;
      thumbInflight.current.add(key);
      if (job.level === "l0") thumbActiveL0.current++;
      else thumbActiveL1.current++;
      void thumbUrl(job.path, job.level)
        .then((url) => {
          const st = thumbState.current.get(job.path) ?? {};
          thumbState.current.set(job.path, { ...st, [job.level]: url, failed: false });
          setThumbTick((t) => t + 1);
        })
        .catch(() => {
          const st = thumbState.current.get(job.path) ?? {};
          thumbState.current.set(job.path, { ...st, failed: true });
          setThumbTick((t) => t + 1);
        })
        .finally(() => {
          if (job.level === "l0") thumbActiveL0.current--;
          else thumbActiveL1.current--;
          thumbInflight.current.delete(key);
          pumpThumbs();
        });
    }
  }, []);

  useEffect(() => {
    if (entries.length === 0) return;
    const visible = entries
      .slice(range.start, range.end)
      .map((e) => e.path)
      .filter((p) => !requestedRef.current.has(p));
    const nextEnd = Math.min(entries.length, range.end + range.columns * range.pageRows);
    const prefetch = entries
      .slice(range.end, nextEnd)
      .map((e) => e.path)
      .filter((p) => !requestedRef.current.has(p));

    for (const p of [...visible, ...prefetch]) requestedRef.current.add(p);
    if (visible.length) {
      void schedulerRef.current?.request(visible, PRIORITY.visible).then((r) => applyStats(r.stats));
    }
    if (prefetch.length) {
      void schedulerRef.current
        ?.request(prefetch, PRIORITY.prefetch)
        .then((r) => applyStats(r.stats));
    }

    // 缩略图：先把可见区的 L0 全部排完，再排 L1（`01-方案文档.md` 分级占位）。
    // 已经滚出窗口的排队任务直接丢掉——1 万项快滚会堆出几千个陈旧任务，
    // 留着会把新进视口的格子排在它们后面。
    const inRange = entries.slice(range.start, range.end);
    const wanted = new Set(inRange.map((e) => e.path));
    thumbQueue.current = thumbQueue.current.filter((j) => wanted.has(j.path));
    for (const level of ["l0", "l1"] as const) {
      for (const e of inRange) {
        const st = thumbState.current.get(e.path);
        if (st?.[level] || st?.failed) continue;
        const key = `${e.path}|${level}`;
        if (thumbInflight.current.has(key)) continue;
        if (thumbQueue.current.some((j) => j.path === e.path && j.level === level)) continue;
        thumbQueue.current.push({ path: e.path, level });
      }
    }
    pruneThumbs(wanted);
    pumpThumbs();
  }, [entries, range, applyStats, pruneThumbs, pumpThumbs]);

  /* ---------------- 选择 ---------------- */

  const pick = useCallback(
    (path: string, opts: { additive: boolean; range: boolean }) => {
      const list = entriesRef.current;
      const idx = list.findIndex((e) => e.path === path);
      const anchorIdx = currentRef.current
        ? list.findIndex((e) => e.path === currentRef.current)
        : idx;
      setSelected((prev) => {
        const next = new Set(prev);
        if (opts.range && anchorIdx >= 0) {
          const [a, b] = anchorIdx < idx ? [anchorIdx, idx] : [idx, anchorIdx];
          for (let i = a; i <= b; i++) next.add(list[i].path);
        } else if (opts.additive) {
          if (next.has(path)) next.delete(path);
          else next.add(path);
        } else {
          next.clear();
          next.add(path);
        }
        return next;
      });
      setCurrent(path);
    },
    []
  );

  const pickByIndex = useCallback(
    (index: number, opts: { additive?: boolean; range?: boolean } = {}) => {
      const list = entriesRef.current;
      if (list.length === 0) return;
      const i = Math.max(0, Math.min(list.length - 1, index));
      pick(list[i].path, { additive: !!opts.additive, range: !!opts.range });
    },
    [pick]
  );

  /* ---------------- 键位（§10.2；M2 批次） ---------------- */

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (isComposing(ev) || isTextInput(ev.target)) return;
      const list = entriesRef.current;
      if (list.length === 0) return;
      const idx = currentRef.current
        ? list.findIndex((e) => e.path === currentRef.current)
        : -1;
      const page = Math.max(1, rangeRef.current.columns * rangeRef.current.pageRows);
      const move = (to: number, range: boolean) => pickByIndex(to, { range });

      switch (ev.key) {
        case "ArrowRight":
          ev.preventDefault();
          move(idx + 1, ev.shiftKey);
          return;
        case "ArrowLeft":
          ev.preventDefault();
          move(idx - 1, ev.shiftKey);
          return;
        case "ArrowDown":
          ev.preventDefault();
          move(idx + rangeRef.current.columns, ev.shiftKey);
          return;
        case "ArrowUp":
          ev.preventDefault();
          move(idx - rangeRef.current.columns, ev.shiftKey);
          return;
        case "Home":
          ev.preventDefault();
          move(0, ev.shiftKey);
          return;
        case "End":
          ev.preventDefault();
          move(list.length - 1, ev.shiftKey);
          return;
        case "PageUp":
          ev.preventDefault();
          move(idx - page, ev.shiftKey);
          return;
        case "PageDown":
          ev.preventDefault();
          move(idx + page, ev.shiftKey);
          return;
        case "Escape":
          setSelected(new Set());
          return;
        case "Enter":
          // 全屏看图属 M5（屏 2），M2 只保留键位入口，不虚构未设计的视图。
          return;
        case "-":
        case "_":
          if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
          ev.preventDefault();
          onCellIdxChange(Math.max(1, cellIdxRef.current - 1));
          return;
        case "=":
        case "+":
          if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
          ev.preventDefault();
          onCellIdxChange(Math.min(5, cellIdxRef.current + 1));
          return;
        default:
          break;
      }

      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") {
        ev.preventDefault();
        setSelected(new Set(list.map((e) => e.path)));
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "d") {
        ev.preventDefault();
        setSelected(new Set());
        return;
      }
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

      if (/^[0-5]$/.test(ev.key)) {
        const rating = Number(ev.key);
        const targets = selectedRef.current.size
          ? [...selectedRef.current]
          : currentRef.current
            ? [currentRef.current]
            : [];
        if (targets.length) {
          setRatings((prev) => {
            const next = new Map(prev);
            for (const p of targets) next.set(p, rating);
            return next;
          });
        }
        return;
      }
      if (ev.key.toLowerCase() === "p") {
        const targets = selectedRef.current.size
          ? [...selectedRef.current]
          : currentRef.current
            ? [currentRef.current]
            : [];
        if (targets.length) {
          setFavorites((prev) => {
            const next = new Set(prev);
            for (const p of targets) {
              if (next.has(p)) next.delete(p);
              else next.add(p);
            }
            return next;
          });
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCellIdxChange, pickByIndex]);

  /* ---------------- 状态栏 ---------------- */

  useEffect(() => {
    const total = entries.length;
    const known = statsRef.current.size;
    const currentEntry = current ? entries.find((e) => e.path === current) : undefined;
    onStatus({
      dir,
      total,
      selected: selected.size,
      knownBytes: [...statsRef.current.values()].reduce((s, r) => s + r.size, 0),
      statsComplete: total > 0 && known >= total,
      cell: CELLS[cellIdx - 1],
      currentName: currentEntry?.name ?? null,
      currentPath: current,
      currentSize: current ? statsRef.current.get(current)?.size ?? null : null,
      currentRating: current ? ratings.get(current) ?? null : null,
    });
  }, [entries, selected, cellIdx, dir, current, ratings, onStatus, thumbTick]);

  return (
    <Grid
      items={entries}
      cellIdx={cellIdx}
      selected={selected}
      current={current}
      thumbs={thumbState.current}
      ratings={ratings}
      favorites={favorites}
      onPick={pick}
      onRate={(path) =>
        setRatings((prev) => {
          const next = new Map(prev);
          next.set(path, ((next.get(path) ?? 0) + 1) % 6);
          return next;
        })
      }
      onFavorite={(path) =>
        setFavorites((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        })
      }
      onOpen={() => {
        /* 屏 2（M5）落地后接全屏看图 */
      }}
      onVisibleRange={onVisibleRange}
    />
  );
}
