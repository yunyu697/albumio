/**
 * 屏 1 的网格浏览（04-项目计划 M2）。
 *
 * 数据路径（`docs/spike/S4.md`）：`albumio_list` 只 readdir → 立刻出格子 →
 * P0 可见区 / P1 预取 / P2 当前目录分批补 stat → L0 先上屏、L1 补位。
 * 键位按 02-设计规范 §10.2，输入态与 IME 组合期一律忽略（§10.6）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";
import Viewer from "../components/Viewer";
import Grid, { CELLS, type ThumbState, type TimelineGroup } from "../components/Grid";
import Toast, { type ToastData } from "../components/Toast";
import { formatBytes } from "../format";
import {
  PRIORITY,
  createScheduler,
  deletePaths,
  listDir,
  releaseThumb,
  restorePaths,
  takenTimes,
  thumbUrl,
  type Entry,
  type StatRow,
} from "../data/source";
import { bucketize, type TakenInfo } from "../data/timeline";
import type { StatScheduler } from "../data/scheduler";
import { isComposing, isTextInput } from "../keys";

export type BrowseView = "folder" | "timeline";

export interface GridStatus {
  dir: string;
  total: number;
  selected: number;
  knownBytes: number;
  selectedBytes: number;
  statsKnown: number;
  statsComplete: boolean;
  view: BrowseView;
  /** 时间线读取拍摄时间的进度；不在时间线时 done = total。 */
  dated: number;
  cell: number;
  currentName: string | null;
  currentPath: string | null;
  currentSize: number | null;
  currentRating: number | null;
}

interface BrowseProps {
  dir: string;
  view: BrowseView;
  /** 外部触发的重列（F5、撤销删除）。 */
  reloadKey: number;
  cellIdx: number;
  onCellIdxChange: (n: number) => void;
  onStatus: (s: GridStatus) => void;
  /** 工具栏「全屏看图」每次点击自增；Browse 自己持有 viewer，App 只发信号。 */
  openViewerKey: number;
  /** viewer 打开时 App 要放掉全局键（Alt 导航等）。 */
  onViewerOpen: (open: boolean) => void;
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

export default function Browse({
  dir,
  view,
  reloadKey,
  cellIdx,
  onCellIdxChange,
  onStatus,
  openViewerKey,
  onViewerOpen,
}: BrowseProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [ratings, setRatings] = useState<Map<string, number>>(new Map());
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<Range>({ start: 0, end: 0, columns: 1, pageRows: 1 });
  const [thumbTick, setThumbTick] = useState(0);
  // 时间线读取的拍摄时间；键是 path，值带 inferred（缺失 EXIF 时后端回退 mtime）。
  const [taken, setTaken] = useState<Map<string, TakenInfo>>(new Map());
  const [dated, setDated] = useState(0);
  // 删除确认框与 Toast（§11.6）；null 表示不显示。
  const [dialog, setDialog] = useState<{ paths: string[]; permanent: boolean } | null>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  // 撤销后整目录重列一次（删除本身只做本地移除，不必重列）。
  const [reload, setReload] = useState(0);
  // 屏 2（M5）：null = 不显示；数字是 viewer 内部的当前项下标。
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

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
  /** 可视顺序（时间线按分桶后的顺序），键盘与连选都走它。 */
  const viewRef = useRef<Entry[]>([]);
  const selectedRef = useRef<Set<string>>(new Set());
  const rangeRef = useRef<Range>(range);
  const cellIdxRef = useRef(cellIdx);
  const dialogRef = useRef<{ paths: string[]; permanent: boolean } | null>(null);
  const busyRef = useRef(false);
  const toastIdRef = useRef(0);
  const viewerIndexRef = useRef<number | null>(null);

  currentRef.current = current;
  entriesRef.current = entries;
  selectedRef.current = selected;
  rangeRef.current = range;
  cellIdxRef.current = cellIdx;
  dialogRef.current = dialog;
  viewerIndexRef.current = viewerIndex;

  /* ---------------- 时间线与可视顺序（M3） ---------------- */

  // 拍摄时间全部读完才切分组：边读边分组会让格子跳来跳去（01-方案文档 §4.5）。
  const datesReady =
    view === "timeline" && entries.length > 0 && dated >= entries.length && taken.size >= entries.length;

  const groups: TimelineGroup[] | undefined = useMemo(() => {
    if (!datesReady) return undefined;
    return bucketize(entries, taken, Date.now()).map((b) => ({
      key: b.key,
      label: b.label,
      inferred: b.inferred,
      items: b.items.map((i) => i.entry),
    }));
  }, [datesReady, entries, taken]);

  const viewEntries = useMemo(
    () => (groups ? groups.flatMap((g) => g.items) : entries),
    [groups, entries]
  );

  viewRef.current = viewEntries;

  if (!schedulerRef.current) schedulerRef.current = createScheduler();

  /* ---------------- 载入目录 ---------------- */

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
        setTaken(new Map());
        setDated(0);
        setEntries(r.entries);
        const first = r.entries[0]?.path ?? null;
        // 只给"当前项"不给选中：未选中时状态栏中段显示目录摘要（§9）。
        setCurrent(first);
        setSelected(new Set());
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
  }, [dir, reload, reloadKey]);

  // 时间线：按批读拍摄时间（一批 250，串行——EXIF 读取是磁盘操作，并发只会让机械盘抖动）。
  useEffect(() => {
    if (view !== "timeline" || entries.length === 0) return;
    let alive = true;
    const next = new Map<string, TakenInfo>();
    const paths = entries.map((e) => e.path);
    const CHUNK = 250;
    (async () => {
      for (let i = 0; i < paths.length; i += CHUNK) {
        const slice = paths.slice(i, i + CHUNK);
        try {
          const rows = await takenTimes(slice);
          for (const r of rows) {
            next.set(r.path, {
              takenAt: r.takenAt > 0 ? r.takenAt : Date.now(),
              inferred: r.failed || r.source === "inferred",
            });
          }
        } catch {
          for (const p of slice) next.set(p, { takenAt: Date.now(), inferred: true });
        }
        if (!alive) return;
        setTaken(new Map(next));
        setDated(Math.min(paths.length, i + slice.length));
      }
    })();
    return () => {
      alive = false;
    };
  }, [view, entries, reload]);

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
    if (viewEntries.length === 0) return;
    const visible = viewEntries
      .slice(range.start, range.end)
      .map((e) => e.path)
      .filter((p) => !requestedRef.current.has(p));
    const nextEnd = Math.min(viewEntries.length, range.end + range.columns * range.pageRows);
    const prefetch = viewEntries
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
    const inRange = viewEntries.slice(range.start, range.end);
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
  }, [viewEntries, range, applyStats, pruneThumbs, pumpThumbs]);

  /* ---------------- 选择 ---------------- */

  const pick = useCallback(
    (path: string, opts: { additive: boolean; range: boolean }) => {
      // 连选范围按可视顺序（时间线就是分桶后的顺序），与用户看到的排列一致。
      const list = viewRef.current;
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
      const list = viewRef.current;
      if (list.length === 0) return;
      const i = Math.max(0, Math.min(list.length - 1, index));
      pick(list[i].path, { additive: !!opts.additive, range: !!opts.range });
    },
    [pick]
  );

  /* ---------------- 删除（§11.6） ---------------- */

  const showToast = useCallback((data: Omit<ToastData, "id">) => {
    setToast({ ...data, id: ++toastIdRef.current });
  }, []);

  /** 从网格、统计与选中集里移除已删除的条目，并把当前项顺延到下一个。 */
  const applyRemoved = useCallback((paths: string[]) => {
    const gone = new Set(paths);
    const list = entriesRef.current;
    const firstGone = list.findIndex((e) => gone.has(e.path));
    for (const p of paths) {
      const st = thumbState.current.get(p);
      if (st?.l0) releaseThumb(p, "l0", st.l0);
      if (st?.l1) releaseThumb(p, "l1", st.l1);
      thumbState.current.delete(p);
      statsRef.current.delete(p);
      requestedRef.current.delete(p);
    }
    const rest = list.filter((e) => !gone.has(e.path));
    setEntries(rest);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) next.delete(p);
      return next;
    });
    setCurrent((cur) => {
      if (!cur || !gone.has(cur)) return cur;
      const next = rest[Math.min(Math.max(firstGone, 0), rest.length - 1)];
      return next?.path ?? null;
    });
    setThumbTick((t) => t + 1);
  }, []);

  const undoTrash = useCallback(
    async (paths: string[], since: number) => {
      try {
        const out = await restorePaths(paths, since);
        if (out.failed.length) {
          showToast({ text: `撤销失败：${out.failed[0].reason}`, error: true });
          return;
        }
        setReload((n) => n + 1);
      } catch (e) {
        showToast({ text: `撤销失败：${String(e)}`, error: true });
      }
    },
    [showToast]
  );

  const runDelete = useCallback(
    async (paths: string[], permanent: boolean) => {
      if (busyRef.current || paths.length === 0) return;
      busyRef.current = true;
      try {
        const out = await deletePaths(paths, permanent);
        if (out.deleted.length) applyRemoved(out.deleted);
        if (out.failed.length) {
          // 部分失败必须说出来：用户以为删掉了、实际还在，比直接报错更糟。
          showToast({
            text: `${out.failed.length} 个项目删除失败：${out.failed[0].reason}`,
            error: true,
          });
        } else if (!permanent && out.canUndo) {
          showToast({
            text: "已移到回收站",
            action: { label: "撤销", run: () => void undoTrash(out.deleted, out.at) },
          });
        }
      } catch (e) {
        showToast({ text: `删除失败：${String(e)}`, error: true });
      } finally {
        busyRef.current = false;
      }
    },
    [applyRemoved, showToast, undoTrash]
  );

  /** 关闭确认框后把焦点还给网格当前项所在区域（§11.6.5）。 */
  const closeDialog = useCallback((then?: () => void) => {
    setDialog(null);
    then?.();
    requestAnimationFrame(() => {
      (document.querySelector(".stage") as HTMLElement | null)?.focus();
    });
  }, []);

  /* ---------------- 屏 2：全屏看图（M5） ---------------- */

  /** 打开全屏看图；给了 path 就从那张开始，否则从当前项开始。 */
  const openViewer = useCallback((path?: string | null) => {
    const list = viewRef.current;
    if (list.length === 0) return;
    const target = path ?? currentRef.current ?? list[0]?.path;
    const i = target ? list.findIndex((e) => e.path === target) : -1;
    setViewerIndex(i >= 0 ? i : 0);
  }, []);

  // App 的全局键（Alt 导航等）在 viewer 期间要让位；keydown 之前状态已提交。
  useEffect(() => {
    onViewerOpen(viewerIndex !== null);
  }, [viewerIndex, onViewerOpen]);

  // 工具栏「全屏看图」：App 只递增信号，不把网格数据往上搬。
  const seenOpenKey = useRef(openViewerKey);
  useEffect(() => {
    if (openViewerKey === seenOpenKey.current) return;
    seenOpenKey.current = openViewerKey;
    openViewer();
  }, [openViewerKey, openViewer]);

  /* ---------------- 键位（§10.2；M2 批次） ---------------- */

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (isComposing(ev) || isTextInput(ev.target)) return;
      // 确认框打开时，网格不响应任何键（Esc / Enter 由对话框自己处理，§11.6.5）。
      if (dialogRef.current) return;
      // 全屏看图期间键位归 viewer（§10.3），网格不抢方向键与 Esc。
      if (viewerIndexRef.current !== null) return;
      const list = viewRef.current;
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
        case "Delete": {
          // 单文件 Delete 直接进回收站（不弹框）；Shift+Delete 与多选才二次确认（§11.6.1）。
          const targets = selectedRef.current.size
            ? [...selectedRef.current]
            : currentRef.current
              ? [currentRef.current]
              : [];
          if (targets.length === 0) return;
          ev.preventDefault();
          if (!ev.shiftKey && targets.length === 1) {
            void runDelete(targets, false);
            return;
          }
          setDialog({ paths: targets, permanent: ev.shiftKey });
          return;
        }
        case "Enter":
          // 屏 2（M5）：Enter 从当前项打开全屏看图。
          ev.preventDefault();
          openViewer();
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
  }, [onCellIdxChange, pickByIndex, runDelete, openViewer]);

  /* ---------------- 状态栏 ---------------- */

  useEffect(() => {
    const total = entries.length;
    const known = statsRef.current.size;
    const currentEntry = current ? entries.find((e) => e.path === current) : undefined;
    let selectedBytes = 0;
    for (const p of selected) selectedBytes += statsRef.current.get(p)?.size ?? 0;
    onStatus({
      dir,
      total,
      selected: selected.size,
      knownBytes: [...statsRef.current.values()].reduce((s, r) => s + r.size, 0),
      selectedBytes,
      statsKnown: known,
      statsComplete: total > 0 && known >= total,
      view,
      dated: view === "timeline" ? dated : total,
      cell: CELLS[cellIdx - 1],
      currentName: currentEntry?.name ?? null,
      currentPath: current,
      currentSize: current ? statsRef.current.get(current)?.size ?? null : null,
      currentRating: current ? ratings.get(current) ?? null : null,
    });
  }, [
    entries,
    selected,
    cellIdx,
    dir,
    current,
    ratings,
    onStatus,
    thumbTick,
    view,
    dated,
  ]);

  /* ---------------- 确认框文案（§11.6.3） ---------------- */

  const dialogView = (() => {
    if (!dialog) return null;
    const n = dialog.paths.length;
    const names = dialog.paths.map((p) => p.split(/[\\/]/).pop() ?? p);
    const sum = dialog.paths.reduce((s, p) => s + (statsRef.current.get(p)?.size ?? 0), 0);
    const size = sum > 0 ? formatBytes(sum) : "";
    if (dialog.permanent) {
      if (n === 1) {
        return {
          title: `永久删除 ${names[0]}？`,
          body: "此文件将从磁盘删除，不进入系统回收站。",
          names: [],
          note: size ? `${size} · 此操作不可撤销` : "此操作不可撤销",
          confirmLabel: "永久删除",
          danger: true,
        };
      }
      return {
        title: `永久删除 ${n} 个项目？`,
        body: "选中的项目将从磁盘删除，不进入系统回收站。",
        names,
        note: size ? `共 ${size} · 此操作不可撤销` : "此操作不可撤销",
        confirmLabel: "永久删除",
        danger: true,
      };
    }
    return {
      title: `将 ${n} 个项目移到回收站？`,
      body: "可以稍后从系统回收站还原。",
      names,
      note: size ? `共 ${size}` : "",
      confirmLabel: "移到回收站",
      danger: false,
    };
  })();

  return (
    <>
      <Grid
        items={viewEntries}
        groups={groups}
        scrollKey={`${dir}|${view}`}
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
        onOpen={(path) => openViewer(path)}
        onVisibleRange={onVisibleRange}
      />
      {viewerIndex !== null && viewEntries.length > 0 ? (
        <Viewer
          items={viewEntries}
          index={Math.min(viewerIndex, viewEntries.length - 1)}
          onIndexChange={setViewerIndex}
          ratings={ratings}
          favorites={favorites}
          onRate={(path, rating) =>
            setRatings((prev) => {
              const next = new Map(prev);
              next.set(path, rating);
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
          onClose={() => setViewerIndex(null)}
        />
      ) : null}
      {dialogView ? (
        <ConfirmDialog
          {...dialogView}
          onCancel={() => closeDialog()}
          onConfirm={() => {
            const d = dialog;
            closeDialog(() => {
              if (d) void runDelete(d.paths, d.permanent);
            });
          }}
        />
      ) : null}
      <Toast data={toast} onDone={() => setToast(null)} />
    </>
  );
}
