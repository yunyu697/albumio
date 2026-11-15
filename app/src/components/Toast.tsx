/**
 * 删除后的 Toast（`02-设计规范.md` §11.6.7）。
 *
 * 单文件 `Delete` 不弹框，唯一的结果反馈就是这条提示；「撤销」按钮把刚移进
 * 回收站的条目还原。连续删除时新提示直接替换旧的，不排队。
 */

import { useEffect } from "react";

export interface ToastData {
  /** 每次新提示自增，用于重置计时器。 */
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  /** 失败态：停留更久，且不出「撤销」。 */
  error?: boolean;
}

interface ToastProps {
  data: ToastData | null;
  onDone: () => void;
}

export default function Toast({ data, onDone }: ToastProps) {
  useEffect(() => {
    if (!data) return;
    const t = window.setTimeout(onDone, data.error ? 8000 : 6000);
    return () => window.clearTimeout(t);
  }, [data, onDone]);

  if (!data) return null;
  return (
    <div className={`toast${data.error ? " err" : ""}`} role="status" key={data.id}>
      <span className="toast-text">{data.text}</span>
      {data.action ? (
        <button
          className="toast-act"
          onClick={() => {
            data.action?.run();
            onDone();
          }}
        >
          {data.action.label}
        </button>
      ) : null}
    </div>
  );
}
