/**
 * 二次确认对话框（`02-设计规范.md` §11.6）。
 *
 * 只有两个入口会用到它：`Shift+Delete`（永久删除，单文件也弹）与多选 `Delete`
 * （批量移到回收站）。单文件 `Delete` 直接执行、不经过这里（§11.6.1）。
 *
 * 约束全部来自 §11.6.2–11.6.6：宽 400 固定、遮罩点击不关闭、初始焦点在「取消」、
 * `Tab` 只在两个按钮间循环、`Esc` 取消、关闭淡出 `--ds-dur-1`。
 */

import { useEffect, useRef, useState } from "react";

export interface ConfirmDialogProps {
  title: string;
  body: string;
  /** 文件名列表；空数组表示单文件变体（文件名已在标题里，不重复）。 */
  names: string[];
  /** 注释行；空字符串则不渲染。 */
  note: string;
  confirmLabel: string;
  /** 永久删除用 danger 弱底方案，回收站用 accent 实心（§11.6.4）。 */
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** 列表最多 5 行，超出以 `+N 项` 收尾（§11.6.3）。 */
const MAX_ROWS = 5;

export default function ConfirmDialog({
  title,
  body,
  names,
  note,
  confirmLabel,
  danger = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const [closing, setClosing] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const okRef = useRef<HTMLButtonElement | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const close = (then: () => void) => {
    if (startedRef.current) return;
    startedRef.current = true;
    setClosing(true);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(then, reduced ? 0 : 80);
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      close(onCancel);
      return;
    }
    if (ev.key === "Tab") {
      // 焦点只在两个按钮之间循环，不允许落到遮罩或背景网格（§11.6.5）。
      ev.preventDefault();
      if (document.activeElement === cancelRef.current) okRef.current?.focus();
      else cancelRef.current?.focus();
    }
  };

  const shown = names.length > MAX_ROWS ? names.slice(0, MAX_ROWS) : names;
  const rest = names.length - shown.length;

  return (
    <div
      className={`scrim${closing ? " out" : ""}`}
      onClick={(ev) => ev.stopPropagation()}
    >
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dlgTitle"
        aria-describedby="dlgBody"
        onKeyDown={onKeyDown}
      >
        <div className="dlg-title" id="dlgTitle">
          {title}
        </div>
        <p className="dlg-body" id="dlgBody">
          {body}
        </p>
        {shown.length > 0 ? (
          <div className="dlg-list">
            {shown.map((n) => (
              <span key={n}>{n}</span>
            ))}
            {rest > 0 ? <span>+{rest} 项</span> : null}
          </div>
        ) : null}
        {note ? <div className="dlg-note">{note}</div> : null}
        <div className="dlg-foot">
          <button className="btn ghost" ref={cancelRef} onClick={() => close(onCancel)}>
            取消
          </button>
          <button
            className={`btn ${danger ? "danger" : "primary"}`}
            ref={okRef}
            onClick={() => close(onConfirm)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
