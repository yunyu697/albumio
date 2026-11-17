/**
 * 屏 1 的网格浏览（04-项目计划 M2）。
 *
 * 数据路径（`docs/spike/S4.md`）：`albumio_list` 只 readdir → 立刻出格子 →
 * P0 可见区 / P1 预取 / P2 当前目录分批补 stat → L0 先上屏、L1 补位。
 * 键位按 02-设计规范 §10.2，输入态与 IME 组合期一律忽略（§10.6）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";
import Editor from "../components/Editor";
import Viewer from "../components/Viewer";
import { Batch } from "./Batch";
import type { BatchSourceInput } from "../data/batch";
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
  type SortMode,
  type StatRow,
} from "../data/source";
import { bucketize, type TakenInfo } from "../data/timeline";
import { watchDir, type DirChanges } from "../data/watch";
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
  /** 工具栏「编辑」同款信号（屏 3，M6）。 */
  openEditorKey: number;
  /** 工具栏「批量」同款信号（屏 4，M7）。 */
  openBatchKey: number;
  /** M9：外部要求「在目录里打开这张」（双击关联文件 / 拖入图片）；目录列表到齐后再定位。 */
  openFile: string | null;
  openFileKey: number;
  /** viewer / editor / 批量处理打开时 App 要放掉全局键（Alt 导航等）。 */
  onViewerOpen: (open: boolean) => void;
  /** 排序模式：nameAsc / folderThenName 后端做；mtimeDesc / sizeDesc / nameDesc 前端 stat 回来后再排。 */
  sort: SortMode;
  /** 递归列举子目录（穿透）。 */
  recursive: boolean;
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
  openEditorKey,
  openBatchKey,
  openFile,
  openFileKey,
  onViewerOpen,
  sort,
  recursive,
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
  // 屏 4：批量处理打开时冻结一份来源快照（已选优先，否则整目录）。
  const [batchSources, setBatchSources] = useState<BatchSourceInput[] | null>(null);
  // 屏 3（M6）：编辑覆盖层。与 viewer 互斥（设计稿的「返回看图」再回来）。
  const [editorIndex, setEditorIndex] = useState<number | null>(null);

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
  const editorIndexRef = useRef<number | null>(null);
  const batchOpenRef = useRef(false);
  // 增量变更时不能拿 state 里的 taken 做增量（会多一轮重渲染），用 ref 记「已读到的」。
  const takenRef = useRef<Map<string, TakenInfo>>(new Map());

  currentRef.current = current;
  entriesRef.current = entries;
  selectedRef.current = selected;
  rangeRef.current = range;
  cellIdxRef.current = cellIdx;
  dialogRef.current = dialog;
  viewerIndexRef.current = viewerIndex;
  editorIndexRef.current = editorIndex;
  batchOpenRef.current = batchSources !== null;

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
    void listDir(dir, { sort, recursive })
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
        takenRef.current = new Map();
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
  }, [dir, reload, reloadKey, sort, recursive]);

  // 时间线：按批读拍摄时间（一批 250，串行——EXIF 读取是磁盘操作，并发只会让机械盘抖动）。
  // 只读「还没读到过的」路径：外部新增/改名时不能把 1 万项的 EXIF 全部重读一遍。
  useEffect(() => {
    if (view !== "timeline" || entries.length === 0) return;
    let alive = true;
    const paths = entries.map((e) => e.path);
    const next = new Map(takenRef.current);
    const missing = paths.filter((p) => !next.has(p));
    if (missing.length === 0) {
      setDated(paths.length);
      return;
    }
    const CHUNK = 250;
    (async () => {
      for (let i = 0; i < missing.length; i += CHUNK) {
        const slice = missing.slice(i, i + CHUNK);
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
        takenRef.current = next;
        setTaken(new Map(next));
        let known = 0;
        for (const p of paths) if (next.has(p)) known++;
        setDated(known);
      }
    })();
    return () => {
      alive = false;
    };
  }, [view, entries, reload]);

  /** 根据 sort 模式决定是否需要 stat 数据来排序。 */
  const needsStatSort = (s: SortMode) => s === "mtimeDesc" || s === "sizeDesc" || s === "nameDesc";

  const applyStats = useCallback((rows: StatRow[]) => {
    if (rows.length === 0) return;
    const next = statsRef.current;
    for (const r of rows) next.set(r.path, r);
    // stat 回来后，需要 stat 数据的排序模式在这里重排（后端 listDir 只做 readdir 级排序）。
    if (needsStatSort(sort)) {
      setEntries((prev) => {
        const sorted = [...prev].sort((a, b) => {
          const ra = statsRef.current.get(a.path);
          const rb = statsRef.current.get(b.path);
          const cmp = (av?: number, bv?: number) => {
            if (av === undefined && bv === undefined) return 0;
            if (av === undefined) return 1; // 无 stat 放后面
            if (bv === undefined) return -1;
            return bv - av; // desc
          };
          if (sort === "mtimeDesc") return cmp(ra?.mtimeNs, rb?.mtimeNs);
          if (sort === "sizeDesc") return cmp(ra?.size, rb?.size);
          if (sort === "nameDesc") return naturalCmp(b.name, a.name);
          return 0;
        });
        // 保持当前项 / 选中项不变：重排只动 entries 数组，不触发 setCurrent / setSelected。
        return sorted;
      });
    }
    // 复用同一个 tick 驱动重渲染（stat 与缩略图都只是"数据变了"）
    setThumbTick((t) => t + 1);
  }, [sort]);

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

  /* ---------------- 屏 1：外部变更（M8） ---------------- */

  /**
   * 把一批外部变更合进网格：改名迁移 → 删除 → 新增/更新。
   * 只动受影响的条目，不重列目录，选中与滚动位置保持不变。
   */
  const applyChanges = useCallback(
    (changes: DirChanges) => {
      if (changes.overflow) {
        // 监听通道不可信：整目录重建，非模态提示，不阻断浏览（`docs/spike/S6.md` §4）。
        showToast({
          text: "目录变化可能未全部捕获，已自动刷新",
          action: { label: "再次刷新", run: () => setReload((n) => n + 1) },
        });
        setReload((n) => n + 1);
        return;
      }

      // 1. 改名：先把选中/当前/评分/缓存迁到新路径，保住"用户还在看同一张"。
      const moved = new Map<string, string>();
      for (const r of changes.renamed) moved.set(r.from, r.to);
      if (moved.size) {
        const to = (p: string) => moved.get(p) ?? p;
        setCurrent((cur) => (cur ? to(cur) : cur));
        setSelected((prev) => {
          const next = new Set<string>();
          for (const p of prev) next.add(to(p));
          return next;
        });
        setRatings((prev) => migrateMap(prev, moved));
        setFavorites((prev) => migrateSet(prev, moved) ?? prev);
        for (const [from, dest] of moved) {
          const st = statsRef.current.get(from);
          if (st) {
            statsRef.current.delete(from);
            statsRef.current.set(dest, { ...st, path: dest });
          }
          const th = thumbState.current.get(from);
          if (th) {
            thumbState.current.delete(from);
            thumbState.current.set(dest, th);
          }
          requestedRef.current.delete(from);
        }
      }

      // 2. 删除：网格移除、释放缩略图，不留下灰块。
      const gone = new Set(changes.removed);
      if (gone.size) {
        for (const p of gone) {
          const st = thumbState.current.get(p);
          if (st?.l0) releaseThumb(p, "l0", st.l0);
          if (st?.l1) releaseThumb(p, "l1", st.l1);
          thumbState.current.delete(p);
          statsRef.current.delete(p);
          requestedRef.current.delete(p);
        }
        setSelected((prev) => dropSet(prev, gone) ?? prev);
        setRatings((prev) => dropKeys(prev, gone));
        setFavorites((prev) => dropSet(prev, gone) ?? prev);
        setTaken((prev) => {
          if (![...gone].some((p) => prev.has(p))) return prev;
          const next = new Map(prev);
          for (const p of gone) next.delete(p);
          takenRef.current = next;
          return next;
        });
      }

      // 3. 新增/更新：mtime 变了就丢掉旧缩略图，重新解码。
      const byPath = new Map<string, Entry>();
      for (const e of entriesRef.current) {
        if (!gone.has(e.path)) byPath.set(e.path, e);
      }
      for (const u of changes.upserts) {
        const before = statsRef.current.get(u.path);
        if (!before || before.mtimeNs !== u.mtimeNs) {
          const st = thumbState.current.get(u.path);
          if (st?.l0) releaseThumb(u.path, "l0", st.l0);
          if (st?.l1) releaseThumb(u.path, "l1", st.l1);
          thumbState.current.delete(u.path);
        }
        byPath.set(u.path, { name: u.name, path: u.path, isDir: false });
        statsRef.current.set(u.path, { path: u.path, size: u.size, mtimeNs: u.mtimeNs });
        requestedRef.current.add(u.path);
      }
      const next = [...byPath.values()].sort(
        (a, b) => naturalCmp(a.name, b.name) || naturalCmp(a.path, b.path)
      );
      setEntries(next);
      setThumbTick((t) => t + 1);

      // 当前项被外部删掉：顺延到原位置的下一个，而不是跳回第一张。
      setCurrent((cur) => {
        if (!cur || !gone.has(cur)) return cur;
        const list = entriesRef.current;
        const i = list.findIndex((e) => e.path === cur);
        const fallback = next[Math.min(Math.max(i, 0), next.length - 1)];
        return fallback?.path ?? null;
      });

      // 时间线：新增项补拍摄时间，分组在下一轮 bucketize 时自动落位。
      if (view === "timeline" && changes.upserts.length) {
        const paths = changes.upserts.map((u) => u.path);
        void takenTimes(paths)
          .then((rows) => {
            setTaken((prev) => {
              if (rows.length === 0) return prev;
              const nextMap = new Map(prev);
              for (const r of rows) {
                nextMap.set(r.path, {
                  takenAt: r.takenAt > 0 ? r.takenAt : Date.now(),
                  inferred: r.failed || r.source === "inferred",
                });
              }
              takenRef.current = nextMap;
              return nextMap;
            });
          })
          .catch(() => {
            /* 读不到就回退 mtime，不阻断网格 */
          });
      }
    },
    [showToast, view]
  );

  // 监听当前目录；回调走 ref，避免每次重渲染都重启监听。
  const applyChangesRef = useRef(applyChanges);
  applyChangesRef.current = applyChanges;
  useEffect(() => {
    if (!dir) return;
    let alive = true;
    let stop: (() => void) | null = null;
    void watchDir(dir, (c) => applyChangesRef.current(c)).then((fn) => {
      if (alive) stop = fn;
      else fn();
    });
    return () => {
      alive = false;
      stop?.();
    };
  }, [dir]);

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

  /** 打开编辑；从看图进来时顺手退出 viewer，避免两层覆盖层抢键位。 */
  const openEditor = useCallback((path?: string | null) => {
    const list = viewRef.current;
    if (list.length === 0) return;
    const target = path ?? currentRef.current ?? list[0]?.path;
    const i = target ? list.findIndex((e) => e.path === target) : -1;
    setViewerIndex(null);
    setEditorIndex(i >= 0 ? i : 0);
  }, []);

  // App 的全局键（Alt 导航等）在 viewer/editor/批量期间要让位；keydown 之前状态已提交。
  useEffect(() => {
    onViewerOpen(viewerIndex !== null || editorIndex !== null || batchSources !== null);
  }, [viewerIndex, editorIndex, batchSources, onViewerOpen]);

  // 工具栏「全屏看图」：App 只递增信号，不把网格数据往上搬。
  const seenOpenKey = useRef(openViewerKey);
  useEffect(() => {
    if (openViewerKey === seenOpenKey.current) return;
    seenOpenKey.current = openViewerKey;
    openViewer();
  }, [openViewerKey, openViewer]);

  // M9：双击关联文件/拖入图片——先把目标存起来，等目录列表回来再定位，
  // 否则换目录的那一帧里 viewEntries 还是旧目录，会退化成「打开第一张」。
  const pendingOpenRef = useRef<string | null>(null);
  const seenOpenFileKey = useRef(openFileKey);
  useEffect(() => {
    if (openFileKey !== seenOpenFileKey.current) {
      seenOpenFileKey.current = openFileKey;
      pendingOpenRef.current = openFile;
    }
    const pending = pendingOpenRef.current;
    if (!pending) return;
    if (!viewEntries.some((e) => e.path === pending)) return;
    pendingOpenRef.current = null;
    openViewer(pending);
  }, [openFileKey, openFile, viewEntries, openViewer]);

  // 工具栏「编辑」：同一套信号。
  const seenEditorKey = useRef(openEditorKey);
  useEffect(() => {
    if (openEditorKey === seenEditorKey.current) return;
    seenEditorKey.current = openEditorKey;
    openEditor();
  }, [openEditorKey, openEditor]);

  // 工具栏「批量」：已选优先，否则整目录；尺寸交给后端规划时探测。
  const seenBatchKey = useRef(openBatchKey);
  useEffect(() => {
    if (openBatchKey === seenBatchKey.current) return;
    seenBatchKey.current = openBatchKey;
    const images = entries.filter((e) => !e.isDir);
    const chosen = selected.size > 0 ? images.filter((e) => selected.has(e.path)) : images;
    if (chosen.length === 0) return;
    setViewerIndex(null);
    setEditorIndex(null);
    setBatchSources(
      chosen.map((e) => {
        const stat = statsRef.current.get(e.path);
        const stamp = stat ? shotStamp(Math.round(stat.mtimeNs / 1e6)) : { date: "", time: "" };
        return {
          path: e.path,
          name: e.name,
          width: 0,
          height: 0,
          size: stat?.size ?? 0,
          camera: "",
          date: stamp.date,
          time: stamp.time,
        };
      })
    );
  }, [openBatchKey, entries, selected]);

  /* ---------------- 键位（§10.2；M2 批次） ---------------- */

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (isComposing(ev) || isTextInput(ev.target)) return;
      // 确认框打开时，网格不响应任何键（Esc / Enter 由对话框自己处理，§11.6.5）。
      if (dialogRef.current) return;
      // 全屏看图/编辑期间键位归覆盖层（§10.3 / §10.4），网格不抢方向键与 Esc。
      if (
        viewerIndexRef.current !== null ||
        editorIndexRef.current !== null ||
        batchOpenRef.current
      )
        return;
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
          onEdit={(path) => openEditor(path)}
          onClose={() => setViewerIndex(null)}
        />
      ) : null}
      {editorIndex !== null && viewEntries.length > 0 ? (
        <Editor
          items={viewEntries}
          index={Math.min(editorIndex, viewEntries.length - 1)}
          onIndexChange={setEditorIndex}
          onBackToViewer={() => {
            const i = editorIndexRef.current ?? 0;
            setEditorIndex(null);
            setViewerIndex(i);
          }}
          onClose={() => setEditorIndex(null)}
          onExported={() => setReload((n) => n + 1)}
        />
      ) : null}
      {batchSources ? (
        <Batch
          dir={dir}
          sources={batchSources}
          onClose={() => setBatchSources(null)}
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

/** 批量重命名模板的本地时区占位符（`YYYYMMDD` / `HHMMSS`）。 */
function shotStamp(ms: number): { date: string; time: string } {
  if (!ms) return { date: "", time: "" };
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`,
    time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
  };
}

/* ---------------- 增量变更的小工具（M8） ---------------- */

/** 改名迁移：只在新旧值不同时换引用，避免无谓重渲染。 */
function migrateMap<T>(prev: Map<string, T>, moved: Map<string, string>): Map<string, T> {
  let changed = false;
  const next = new Map(prev);
  for (const [from, to] of moved) {
    const value = next.get(from);
    if (value === undefined) continue;
    next.delete(from);
    next.set(to, value);
    changed = true;
  }
  return changed ? next : prev;
}

function migrateSet(prev: Set<string>, moved: Map<string, string>): Set<string> | null {
  let changed = false;
  const next = new Set<string>();
  for (const p of prev) {
    const to = moved.get(p) ?? p;
    if (to !== p) changed = true;
    next.add(to);
  }
  return changed ? next : null;
}

function dropKeys<T>(prev: Map<string, T>, gone: Set<string>): Map<string, T> {
  if (![...gone].some((p) => prev.has(p))) return prev;
  const next = new Map(prev);
  for (const p of gone) next.delete(p);
  return next;
}

function dropSet(prev: Set<string>, gone: Set<string>): Set<string> | null {
  if (![...gone].some((p) => prev.has(p))) return null;
  const next = new Set(prev);
  for (const p of gone) next.delete(p);
  return next;
}

/** 与后端的自然序一致：数字段按数值比（`DSC_2` 在 `DSC_10` 前）。 */
function naturalCmp(a: string, b: string): number {
  const ax = a.match(/(\d+|\D+)/g) ?? [];
  const bx = b.match(/(\d+|\D+)/g) ?? [];
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const x = ax[i];
    const y = bx[i];
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
      // 数值相同再按位数：001 与 1 不应互换位置。
      if (x.length !== y.length) return x.length - y.length;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}
