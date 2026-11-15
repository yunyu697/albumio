/** 屏 4：批量处理（04-项目计划 M7 / `02-设计规范.md` §11.5）。
 *
 * 几何与 class 名沿用 `design/index.html#ov-batch`：`.b-head` 48、`.b-settings` 360、
 * 行高 28、主按钮 36、进度条 4。状态机：空闲 → 处理中 ⇄ 暂停 → 完成；
 * 完成后右栏换成「处理结果」，主按钮原位变「完成」。 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { formatBytes } from "../format";
import {
  cancelBatch,
  planBatch,
  runBatch,
  type BatchFormat,
  type BatchItemResult,
  type BatchOptions,
  type BatchPlan,
  type BatchPlanItem,
  type BatchProgress,
  type BatchSourceInput,
  type ResizeMode,
} from "../data/batch";
import { join } from "../data/batch-naming";

type Phase = "idle" | "running" | "paused" | "done";

interface BatchProps {
  dir: string;
  sources: BatchSourceInput[];
  onClose: () => void;
}

function dirName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toUpperCase() : "—";
}

function defaultOutDir(dir: string): string {
  return join(dir, "导出");
}

export function Batch({ dir, sources: seed, onClose }: BatchProps) {
  const [sources] = useState(seed);
  const [checked, setChecked] = useState(() => new Set(seed.map((s) => s.path)));
  const [outDir] = useState(() => defaultOutDir(dir));
  const [rename, setRename] = useState(true);
  const [pattern, setPattern] = useState("{日期}_{序号}_{原名}");
  const [convert, setConvert] = useState(true);
  const [format, setFormat] = useState<BatchFormat>("jpeg");
  const [quality, setQuality] = useState(90);
  const [resizeOn, setResizeOn] = useState(true);
  const [resize, setResize] = useState<ResizeMode>("long2048");

  const [plan, setPlan] = useState<BatchPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [results, setResults] = useState<Map<string, BatchItemResult>>(new Map());
  const [runningSrc, setRunningSrc] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const resultsRef = useRef(results);
  resultsRef.current = results;
  const runActive = useRef(false);

  const options = useMemo<BatchOptions>(
    () => ({
      outDir,
      rename,
      pattern,
      convert,
      format,
      quality,
      resize: resizeOn ? resize : "none",
    }),
    [outDir, rename, pattern, convert, format, quality, resizeOn, resize]
  );

  /* 规划：选项变了就重算输出名与预计尺寸（处理中冻结）。 */
  useEffect(() => {
    if (phase !== "idle") return;
    const list = sources.filter((s) => checked.has(s.path));
    if (list.length === 0) {
      setPlan(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      planBatch(list, options)
        .then((p) => {
          if (!alive) return;
          setPlan(p);
          setPlanError(null);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setPlan(null);
          setPlanError(String(e));
        });
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [sources, checked, options, phase]);

  const startRun = useCallback(async (items: BatchPlanItem[]) => {
    if (items.length === 0) return;
    runActive.current = true;
    setRunError(null);
    setPhase("running");
    setRunningSrc(null);
    setResults((prev) => {
      const next = new Map(prev);
      for (const item of items) next.delete(item.src);
      return next;
    });
    try {
      const outcome = await runBatch(items, (p: BatchProgress) => {
        const item = items[p.index];
        if (!item) return;
        if (p.phase === "begin") {
          setRunningSrc(item.src);
          return;
        }
        if (p.result) {
          setRunningSrc(null);
          const result = p.result;
          setResults((prev) => new Map(prev).set(item.src, result));
        }
      });
      setPhase(outcome.cancelled ? "paused" : "done");
    } catch (e: unknown) {
      setRunError(String(e));
      setPhase("paused");
    } finally {
      runActive.current = false;
      setRunningSrc(null);
    }
  }, []);

  const close = useCallback(() => {
    if (phase === "running") void cancelBatch();
    onClose();
  }, [phase, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const total = plan?.items.length ?? checked.size;
  const doneCount = useMemo(
    () => [...results.values()].filter((r) => r.status === "done").length,
    [results]
  );
  const skipCount = useMemo(
    () => [...results.values()].filter((r) => r.status === "skipped").length,
    [results]
  );
  const failCount = useMemo(
    () => [...results.values()].filter((r) => r.status === "failed").length,
    [results]
  );
  const processed = results.size;
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  const busy = phase !== "idle";

  const toggleOne = (path: string) => {
    if (busy) return;
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const toggleAll = () => {
    if (busy) return;
    setChecked((prev) => (prev.size === sources.length ? new Set() : new Set(sources.map((s) => s.path))));
  };

  const primary = () => {
    if (phase === "done") {
      onClose();
      return;
    }
    if (phase === "running") {
      setPhase("paused");
      void cancelBatch();
      return;
    }
    if (phase === "paused") {
      if (runActive.current) return; // 当前文件还在收尾
      const remaining = (plan?.items ?? []).filter((i) => !resultsRef.current.has(i.src));
      if (remaining.length === 0) {
        setPhase("done");
        return;
      }
      void startRun(remaining);
      return;
    }
    if (plan) void startRun(plan.items);
  };

  const retry = () => {
    if (!plan) return;
    const failed = plan.items.filter(
      (i) => resultsRef.current.get(i.src)?.status === "failed"
    );
    void startRun(failed);
  };

  const rows = useMemo(() => {
    if (plan) {
      return plan.items.map((item) => {
        const src = sources.find((s) => s.path === item.src);
        return {
          key: item.src,
          name: item.name,
          dim: item.width > 0 && item.height > 0 ? `${item.width}×${item.height}` : "—",
          size: src && src.size > 0 ? formatBytes(src.size) : "—",
          ext: item.sourceFormat.toUpperCase(),
          item,
        };
      });
    }
    return sources
      .filter((s) => checked.has(s.path))
      .map((s) => ({
        key: s.path,
        name: s.name,
        dim: s.width > 0 && s.height > 0 ? `${s.width}×${s.height}` : "—",
        size: s.size > 0 ? formatBytes(s.size) : "—",
        ext: extOf(s.name),
        item: undefined,
      }));
  }, [plan, sources, checked]);

  const issues = useMemo(() => {
    if (!plan) return [];
    return plan.items
      .map((item) => ({ item, result: results.get(item.src) }))
      .filter(
        (x): x is { item: BatchPlanItem; result: BatchItemResult } =>
          !!x.result && (x.result.status === "failed" || x.result.status === "skipped")
      );
  }, [plan, results]);

  const stateOf = (key: string): { cls: string; text: string } => {
    const r = results.get(key);
    if (r) {
      if (r.status === "done") return { cls: "done", text: "完成" };
      if (r.status === "skipped") return { cls: "skip", text: "跳过" };
      return { cls: "fail", text: "失败" };
    }
    if (runningSrc === key) return { cls: "run", text: "处理中" };
    return { cls: "", text: busy ? "待处理" : "" };
  };

  const sub =
    phase === "idle"
      ? `已选 ${checked.size} 项 · 来自「${dirName(dir)}」`
      : phase === "done"
        ? `已完成 ${total} 项`
        : `正在处理 ${processed} / ${total}`;

  const eta =
    phase === "idle" ? `预估输出 ${formatBytes(plan?.estBytes ?? 0)}` : phase === "done" ? "已完成" : `${pct}%`;

  const sumLeft =
    phase === "idle"
      ? planError
        ? "规划失败"
        : (plan?.summary ?? "正在规划…")
      : phase === "done"
        ? `成功 ${doneCount} · 跳过 ${skipCount} · 失败 ${failCount}`
        : `已完成 ${processed} / ${total} · 失败 ${failCount}`;

  const sumRight =
    phase === "idle"
      ? `≈ ${formatBytes(plan?.estBytes ?? 0)}`
      : phase === "done"
        ? failCount > 0
          ? `${failCount} 项失败`
          : "全部完成"
        : `${pct}%`;

  const primaryLabel = phase === "done" ? "完成" : phase === "running" ? "暂停" : phase === "paused" ? "继续" : "开始处理";

  return (
    <div className="overlay batch" id="ov-batch" data-screen="batch">
      <div className="b-head">
        <button className="ibtn" id="bBack" title="返回" onClick={close}>
          <Icon id="i-back" />
        </button>
        <div className="b-title">
          批量处理<span className="b-sub" id="bSub">{sub}</span>
        </div>
        <div className="tsep" />
        <span className="b-sub" id="bEta">
          {eta}
        </span>
        <div className="fb-spacer" />
      </div>

      <div className="b-body">
        <div className="b-list">
          <div className={"b-list-head" + (busy ? " busy" : "")} id="bHeadRow">
            <span className={"cbx" + (checked.size === sources.length ? " on" : "")} onClick={toggleAll}>
              <Icon id="i-check" size="xs" />
            </span>
            <span className="b-name">文件名</span>
            <span className="b-dim">尺寸</span>
            <span className="b-size">大小</span>
            <span className="b-ext">格式</span>
            <span className="b-state">状态</span>
          </div>
          <div className={"b-rows" + (busy ? " busy" : "")} id="bRows">
            {rows.map((row) => {
              const state = stateOf(row.key);
              const isChecked = checked.has(row.key);
              return (
                <div
                  key={row.key}
                  className={
                    "b-row" + (isChecked ? " on" : "") + (state.cls ? ` ${state.cls}` : "")
                  }
                  onClick={() => toggleOne(row.key)}
                >
                  <span className={"cbx" + (isChecked ? " on" : "")}>
                    <Icon id="i-check" size="xs" />
                  </span>
                  <span className="b-name">{row.name}</span>
                  <span className="b-dim">{row.dim}</span>
                  <span className="b-size">{row.size}</span>
                  <span className="b-ext">{row.ext}</span>
                  <span className="b-state">{state.text}</span>
                </div>
              );
            })}
          </div>
        </div>

        <aside className="b-settings">
          <div className="b-set-scroll">
            <div className="sec" id="bResult" hidden={phase !== "done" || issues.length === 0}>
              <div className="sec-h">
                <b>处理结果</b>
                <span className="res-sum" id="bResultSum">
                  <b>{failCount}</b> 失败 · <b>{skipCount}</b> 跳过
                </span>
              </div>
              <div className="b-res" id="bResultList">
                {issues.map(({ item, result }) => (
                  <div
                    key={item.src}
                    className={"res-row" + (result.status === "failed" ? " fail" : "")}
                  >
                    <span className="nm">{item.outName}</span>
                    <span className="rs">{result.reason}</span>
                  </div>
                ))}
              </div>
            </div>

            {phase !== "done" && (
              <>
                <div className="sec" data-cfg>
                  <div className="sec-h">
                    <b>重命名</b>
                    <span
                      className={"switch" + (rename ? " on" : "")}
                      data-switch
                      role="switch"
                      aria-checked={rename}
                      onClick={() => !busy && setRename((v) => !v)}
                    />
                  </div>
                  <div className="field-block">
                    <label className="field-label" htmlFor="rnPattern">
                      模板
                    </label>
                    <input
                      className="textin"
                      id="rnPattern"
                      value={pattern}
                      disabled={!rename || busy}
                      onChange={(e) => setPattern(e.target.value)}
                    />
                    <div className="hint">可用：{"{日期} {时间} {序号} {原名} {相机} {宽}x{高}"}</div>
                  </div>
                  <div className="rename-preview" id="rnPreview">
                    {(plan?.items ?? []).slice(0, 3).map((item) => (
                      <div className="rn" key={item.src}>
                        <span className="old">{item.name}</span>
                        <Icon id="i-chev-right" size="xs" />
                        <span className="new">{item.outName}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="sec" data-cfg>
                  <div className="sec-h">
                    <b>格式转换</b>
                    <span
                      className={"switch" + (convert ? " on" : "")}
                      data-switch
                      role="switch"
                      aria-checked={convert}
                      onClick={() => !busy && setConvert((v) => !v)}
                    />
                  </div>
                  <div className="field-block">
                    <label className="field-label" htmlFor="bFormat">
                      目标格式
                    </label>
                    <div className="selectin">
                      <select
                        id="bFormat"
                        value={format}
                        disabled={!convert || busy}
                        onChange={(e) => setFormat(e.target.value as BatchFormat)}
                      >
                        <option value="jpeg">JPEG</option>
                        <option value="png">PNG</option>
                        <option value="webp">WebP</option>
                      </select>
                      <Icon id="i-chev-down" size="sm" />
                    </div>
                  </div>
                  <div className="slider-block" style={{ marginBottom: 0 }}>
                    <div className="slider-top">
                      <span>质量</span>
                      <b id="valQ">{quality}</b>
                    </div>
                    <input
                      className="lr"
                      style={{ width: "100%" }}
                      type="range"
                      id="q"
                      min={60}
                      max={100}
                      value={quality}
                      disabled={!convert || busy}
                      onChange={(e) => setQuality(Number(e.target.value))}
                    />
                  </div>
                  <div className="hint">保留 EXIF；颜色统一转换为 sRGB 并嵌入 profile。</div>
                </div>

                <div className="sec" data-cfg>
                  <div className="sec-h">
                    <b>尺寸调整</b>
                    <span
                      className={"switch" + (resizeOn ? " on" : "")}
                      data-switch
                      role="switch"
                      aria-checked={resizeOn}
                      onClick={() => !busy && setResizeOn((v) => !v)}
                    />
                  </div>
                  <div className="ratio-row">
                    {(
                      [
                        ["none", "原尺寸"],
                        ["long2048", "长边 2048"],
                        ["long1280", "长边 1280"],
                        ["percent50", "50%"],
                      ] as [ResizeMode, string][]
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        className={"ratio" + (resizeOn && resize === value ? " on" : "")}
                        disabled={!resizeOn || busy}
                        onClick={() => setResize(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="field-block" style={{ marginBottom: 0 }}>
                    <label className="field-label">缩放算法</label>
                    <div className="selectin">
                      <span>Lanczos3（照片）</span>
                      <Icon id="i-chev-down" size="sm" />
                    </div>
                  </div>
                </div>

                <div className="sec" data-cfg style={{ borderBottom: 0 }}>
                  <div className="sec-h">
                    <b>输出</b>
                  </div>
                  <div className="outpath">
                    <Icon id="i-folder" size="sm" />
                    {outDir}
                  </div>
                  <div className="hint">
                    不覆盖原图。命名冲突时自动追加 _1、_2。
                    {plan && plan.conflicts > 0 ? ` 当前 ${plan.conflicts} 个文件名冲突。` : ""}
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="b-foot">
            <div className="b-prog" id="bProg" hidden={phase === "idle"}>
              <i id="bFill" style={{ width: `${pct}%` }} />
            </div>
            <div className="b-sum">
              <span id="bSumLeft">{sumLeft}</span>
              <b id="bSumRight">{sumRight}</b>
            </div>
            {runError && <div className="hint">{runError}</div>}
            <div className="b-actions">
              <button
                className="btn ghost wbtn"
                id="bRetry"
                hidden={phase !== "done" || failCount === 0}
                onClick={retry}
              >
                重新处理失败项
              </button>
              <button className="btn primary wbtn" id="bStart" onClick={primary} disabled={phase === "idle" && !plan}>
                {phase === "idle" && <Icon id="i-play" size="sm" />}
                {primaryLabel}
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
