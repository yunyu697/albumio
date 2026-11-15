/**
 * 目录监听（04-项目计划 M8，屏 1）。
 *
 * Tauri 下：`albumio_watch_start` 启动后台监听，`albumio://dir-changed` 推批次；
 * 批次已按 300 ms 去抖、改名配对、stat 校正过（`docs/spike/S6.md`）。
 *
 * 浏览器假数据下不自动造事件——否则 M2–M7 的截图自检会被无心改动；
 * 只暴露 `window.__albumioWatchEmit` 给无头自检手工投递批次。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "./source";

export interface WatchEntry {
  path: string;
  name: string;
  size: number;
  mtimeNs: number;
}

export interface WatchRename {
  from: string;
  to: string;
}

export interface DirChanges {
  dir: string;
  upserts: WatchEntry[];
  removed: string[];
  renamed: WatchRename[];
  overflow: boolean;
}

declare global {
  interface Window {
    /** 无头自检钩子（仅浏览器假数据）：手工投递一批外部变更。 */
    __albumioWatchEmit?: (changes: DirChanges) => void;
  }
}

let unlisten: UnlistenFn | null = null;
let mockToken = 0;

/**
 * 监听 `dir` 的变更。返回停止函数；同一时间只保留一个监听（换目录前先停）。
 */
export async function watchDir(
  dir: string,
  onChanges: (changes: DirChanges) => void
): Promise<() => void> {
  if (!isTauri()) {
    const token = ++mockToken;
    window.__albumioWatchEmit = (changes) => {
      if (token === mockToken) onChanges(changes);
    };
    return () => {
      if (token !== mockToken) return;
      delete window.__albumioWatchEmit;
    };
  }

  await invoke("albumio_watch_start", { dir });
  unlisten = await listen<DirChanges>("albumio://dir-changed", (ev) => {
    // 换目录的瞬间，旧目录的尾批可能还在路上。
    if (ev.payload.dir !== dir) return;
    onChanges(ev.payload);
  });
  return () => {
    unlisten?.();
    unlisten = null;
    void invoke("albumio_watch_stop").catch(() => {
      /* 窗口正在关闭时停监听失败无所谓 */
    });
  };
}
