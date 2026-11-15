/**
 * 按键分发骨架（规范 §10.6 / §10.8）。
 *
 * M1 只做"什么情况下可以处理快捷键"的判定与注册入口，不绑定任何键位；
 * 首批键位随 M2 的网格一起接入，并同批交付 §10.7 的提示层。
 */

export type ShortcutHandler = () => void;

const bindings = new Map<string, ShortcutHandler>();

/** 输入框 / textarea / select / contenteditable 聚焦时，裸键一律不响应。 */
export function isTextInput(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable === true;
}

/** 组合输入（IME）期间不响应，`keyCode === 229` 是部分 IME 的兜底信号。 */
export function isComposing(ev: KeyboardEvent): boolean {
  return ev.isComposing === true || ev.keyCode === 229;
}

export function shortcutAllowed(ev: KeyboardEvent): boolean {
  if (isComposing(ev)) return false;
  if (isTextInput(ev.target)) return false;
  return true;
}

export function bind(combo: string, run: ShortcutHandler): () => void {
  bindings.set(combo, run);
  return () => bindings.delete(combo);
}

/**
 * 安装全局监听。M1 的 `bindings` 为空，因此这里是纯骨架；
 * 注册表为空时连 `preventDefault` 都不会发生，不影响任何既有交互。
 */
export function installShortcutDispatcher(): () => void {
  const onKeyDown = (ev: KeyboardEvent) => {
    if (!shortcutAllowed(ev)) return;
    const combo = describe(ev);
    const run = combo ? bindings.get(combo) : undefined;
    if (!run) return;
    ev.preventDefault();
    run();
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

/** `Ctrl` 在 macOS 上统一成 `Mod`（规范 §10.6 的映射由这里收口）。 */
export function describe(ev: KeyboardEvent): string | null {
  const key = ev.key;
  if (!key || key === "Shift" || key === "Control" || key === "Alt" || key === "Meta") {
    return null;
  }
  const parts: string[] = [];
  const isMac = navigator.userAgent.includes("Mac");
  if (isMac ? ev.metaKey : ev.ctrlKey) parts.push("Mod");
  if (ev.altKey) parts.push("Alt");
  if (ev.shiftKey) parts.push("Shift");
  parts.push(key.length === 1 ? key.toLowerCase() : key);
  return parts.join("+");
}
