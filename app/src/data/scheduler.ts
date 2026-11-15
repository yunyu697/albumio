/**
 * 分批 stat 的优先级调度（04-项目计划 M2 / docs/spike/S4.md）。
 *
 * 约束：
 * - P0 可见区永远插到最前；同优先级 FIFO；同一时刻只有一批在飞（stat 是磁盘操作，
 *   并发多批只会让机械盘抖动，不会更快）。
 * - generation 一变，排队的旧任务与在飞结果全部作废，不允许旧目录的结果盖回新目录。
 */

export type Priority = 0 | 1 | 2 | 3 | 4;

export interface StatRow {
  path: string;
  size: number;
  mtimeNs: number;
}

export interface StatBatchResult {
  stats: StatRow[];
  cancelled: boolean;
}

export type StatRunner = (
  paths: string[],
  priority: Priority,
  generation: number
) => Promise<StatBatchResult>;

interface Task {
  paths: string[];
  priority: Priority;
  generation: number;
  resolve: (r: StatBatchResult) => void;
}

export class StatScheduler {
  private pending: Task[] = [];
  private inFlight = false;
  private generation = 0;
  private readonly run: StatRunner;

  constructor(run: StatRunner) {
    this.run = run;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** 换目录时调用：丢掉排队任务，在飞任务的结果由 generation 比对丢弃。 */
  setGeneration(generation: number): void {
    this.generation = generation;
    const dropped = this.pending.filter((t) => t.generation !== generation);
    this.pending = this.pending.filter((t) => t.generation === generation);
    for (const t of dropped) t.resolve({ stats: [], cancelled: true });
  }

  request(paths: string[], priority: Priority): Promise<StatBatchResult> {
    if (paths.length === 0) return Promise.resolve({ stats: [], cancelled: false });
    return new Promise((resolve) => {
      this.pending.push({ paths, priority, generation: this.generation, resolve });
      this.pump();
    });
  }

  private takeNext(): Task | undefined {
    if (this.pending.length === 0) return undefined;
    let best = 0;
    for (let i = 1; i < this.pending.length; i++) {
      // 同优先级保持入队顺序：只有严格更小的优先级才插队。
      if (this.pending[i].priority < this.pending[best].priority) best = i;
    }
    return this.pending.splice(best, 1)[0];
  }

  private pump(): void {
    if (this.inFlight) return;
    for (;;) {
      const task = this.takeNext();
      if (!task) return;
      if (task.generation !== this.generation) {
        task.resolve({ stats: [], cancelled: true });
        continue;
      }
      this.inFlight = true;
      const gen = task.generation;
      this.run(task.paths, task.priority, gen)
        .then((r) => {
          if (gen !== this.generation || r.cancelled) {
            task.resolve({ stats: [], cancelled: true });
          } else {
            task.resolve(r);
          }
        })
        .catch(() => task.resolve({ stats: [], cancelled: true }))
        .finally(() => {
          this.inFlight = false;
          this.pump();
        });
      return;
    }
  }
}
