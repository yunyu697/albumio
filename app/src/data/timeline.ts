/**
 * 时间线分桶（04-项目计划 M3 / 01-方案文档 §4.5）。
 *
 * 桶：今天 / 昨天 / 本周 / 本月 / 每年月（`2025 年 10 月`）。
 * 组内顺序：真实拍摄时间在前，推断（回退 mtime）条目排本组末尾；同一半区按时间倒序。
 * 空桶不产生条目（不给占位标题）。日期一律按本地时区取，跨年跨月由日期计算保证。
 */

import type { Entry } from "./source";

export interface TakenInfo {
  takenAt: number;
  inferred: boolean;
}

export interface TimelineItem {
  entry: Entry;
  takenAt: number;
  inferred: boolean;
}

export interface TimelineBucket {
  key: string;
  label: string;
  inferred: number;
  items: TimelineItem[];
}

const DAY = 86_400_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return startOfDay(d.getTime());
}

function startOfMonth(ms: number): number {
  const d = new Date(ms);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 周一为一周之首（与设计稿的「本周」一致）。 */
function startOfWeek(ms: number): number {
  const d = new Date(startOfDay(ms));
  const dow = (d.getDay() + 6) % 7;
  return addDays(d.getTime(), -dow);
}

function monthLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

function ymKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * 把一组条目按拍摄时间分桶。`taken` 必须为每个 path 提供值（缺失时由调用方用 mtime 兜底），
 * 这里不做二次回退——分桶函数保持纯函数，时间线才不会因为 stat 快慢而抖动。
 */
export function bucketize(
  entries: Entry[],
  taken: Map<string, TakenInfo>,
  now: number
): TimelineBucket[] {
  const today = startOfDay(now);
  const yesterday = addDays(today, -1);
  const week = startOfWeek(now);
  const month = startOfMonth(now);

  const map = new Map<string, TimelineBucket>();

  const push = (key: string, label: string, item: TimelineItem) => {
    let b = map.get(key);
    if (!b) {
      b = { key, label, inferred: 0, items: [] };
      map.set(key, b);
    }
    if (item.inferred) b.inferred++;
    b.items.push(item);
  };

  for (const entry of entries) {
    const info = taken.get(entry.path);
    if (!info) continue;
    const item: TimelineItem = {
      entry,
      takenAt: info.takenAt,
      inferred: info.inferred,
    };
    const t = startOfDay(info.takenAt);
    if (t >= today) push("today", "今天", item);
    else if (t >= yesterday) push("yesterday", "昨天", item);
    else if (t >= week) push("week", "本周", item);
    else if (t >= month) push("month", "本月", item);
    else push(`ym:${ymKey(info.takenAt)}`, monthLabel(info.takenAt), item);
  }

  const buckets = [...map.values()];
  for (const b of buckets) {
    b.items.sort(
      (a, z) => (a.inferred ? 1 : 0) - (z.inferred ? 1 : 0) || z.takenAt - a.takenAt
    );
  }
  // 相对桶固定在前，月桶按新到旧；用最大时间做键，跨年也不会排错。
  const rank = (b: TimelineBucket) => {
    const fixed = { today: 0, yesterday: 1, week: 2, month: 3 } as Record<string, number>;
    return b.key in fixed ? fixed[b.key] : 4;
  };
  buckets.sort((a, z) => {
    const ra = rank(a);
    const rz = rank(z);
    if (ra !== rz) return ra - rz;
    const ta = a.items[0]?.takenAt ?? 0;
    const tz = z.items[0]?.takenAt ?? 0;
    return tz - ta;
  });
  return buckets;
}

/** 时间线的可视顺序（键盘上下左右、Shift 连选都按这个走）。 */
export function flatten(buckets: TimelineBucket[]): Entry[] {
  const out: Entry[] = [];
  for (const b of buckets) for (const it of b.items) out.push(it.entry);
  return out;
}

export { DAY };
