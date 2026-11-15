/**
 * 屏 5 的元数据检查器（04-项目计划 M4）。
 *
 * 结构严格按 `design/index.html` 的 `#inspector`：预览 → 文件 → 相机与曝光 →
 * XMP → 直方图 → 标签 → 位置。字段顺序、行高、来源胶囊都由设计稿定义，
 * 这里只负责把 `albumio_meta` 的合并结果填进去。
 *
 * 来源胶囊（EXIF / XMP / 推断）是检查器的核心诚实性：没有拍摄时间就显示
 * 「推断」，绝不让 mtime 冒充 EXIF 时间（`02-设计规范.md` §11.3）。
 */

import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { loadMeta, type MetaSource, type PhotoMeta } from "../data/meta";
import { releaseThumb, thumbUrl } from "../data/source";

interface InspectorProps {
  path: string | null;
  /** 网格里刚评的星级（未写入文件时为本地态），优先于元数据里的 xmp:Rating。 */
  rating: number | null;
  /** 状态栏要用同一份合并结果，避免第二次 IPC 与两处显示不一致。 */
  onMeta?: (m: PhotoMeta | null) => void;
}

const SOURCE_LABEL: Record<MetaSource, string> = {
  exif: "EXIF",
  xmp: "XMP",
  inferred: "推断",
};

function formatBytes(n: number): string {
  if (n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function formatLocal(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

function Field({
  k,
  v,
  cls,
  source,
}: {
  k: string;
  v: React.ReactNode;
  cls?: string;
  source?: MetaSource | null;
}) {
  return (
    <div className="field">
      <span className="field-k">{k}</span>
      <span className={`field-v${cls ? ` ${cls}` : ""}`}>
        {v}
        {source ? <em className="src-tag">{SOURCE_LABEL[source]}</em> : null}
      </span>
    </div>
  );
}

function HistogramChart({ meta }: { meta: PhotoMeta }) {
  const { r, g, b, bins } = meta.histogram;
  const max = Math.max(1, ...r, ...g, ...b);
  // 三通道按 12% 叠加：同一色槽叠出约 36% 的观感，与设计稿的 .45 单层一致，
  // 但保留了「三个通道分别统计」的信息（§11.3）。
  const layer = (data: number[]) =>
    Array.from({ length: bins }, (_, i) => {
      const h = Math.max(2, Math.round(((data[i] ?? 0) / max) * 100));
      return <i key={i} style={{ height: `${h}%` }} />;
    });
  return (
    <div className="hist" aria-label="RGB 直方图">
      {[r, g, b].map((data, idx) => (
        <div key={idx} className="hist-layer">
          {layer(data)}
        </div>
      ))}
    </div>
  );
}

export default function Inspector({ path, rating, onMeta }: InspectorProps) {
  const [meta, setMeta] = useState<PhotoMeta | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  useEffect(() => {
    if (!path) {
      setMeta(null);
      setPreview(null);
      setState("idle");
      onMeta?.(null);
      return;
    }
    let alive = true;
    setState("loading");
    onMeta?.(null); // 换选中时先清掉旧图的尺寸/时间，状态栏不显示错配数据
    void loadMeta(path)
      .then((m) => {
        if (alive) {
          setMeta(m);
          setState("idle");
          onMeta?.(m);
        }
      })
      .catch(() => {
        if (alive) {
          setMeta(null);
          setState("error");
          onMeta?.(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [path, onMeta]);

  useEffect(() => {
    if (!path) {
      setPreview(null);
      return;
    }
    let alive = true;
    void thumbUrl(path, "l1")
      .then((u) => {
        if (alive) setPreview(u);
        else releaseThumb(path, "l1", u);
      })
      .catch(() => {
        if (alive) setPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [path]);

  if (!path) {
    return (
      <div className="insp-scroll">
        <div className="insp-title" style={{ marginTop: 0 }}>
          <span>未选择文件</span>
        </div>
        <div className="field">
          <span className="field-k">提示</span>
          <span className="field-v">在网格中选择一张照片查看元数据</span>
        </div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="insp-scroll">
        <div className="insp-title" style={{ marginTop: 0 }}>
          <span>读取失败</span>
        </div>
        <div className="field">
          <span className="field-k">文件</span>
          <span className="field-v mono">{path.split("/").pop()}</span>
        </div>
      </div>
    );
  }

  const m = meta;
  const stars = rating != null && rating > 0 ? "★".repeat(rating) : m?.rating ? "★".repeat(m.rating) : "—";
  const taken = m
    ? m.takenAtText ?? formatLocal(m.takenAt)
    : state === "loading"
      ? "读取中…"
      : "—";

  return (
    <div className="insp-scroll">
      <div className="insp-preview">
        {preview ? <img src={preview} alt="" /> : null}
      </div>

      <div className="insp-title">
        <span>文件</span>
        <Icon id="i-chev-down" size="xs" />
      </div>
      <Field k="文件名" v={m?.name ?? "—"} cls="mono" />
      <Field
        k="尺寸"
        v={m?.width && m?.height ? `${m.width}×${m.height}` : "—"}
        cls="key"
      />
      <Field k="大小" v={m ? formatBytes(m.size) : "—"} cls="mono" />
      <Field k="格式" v={m ? m.format.toUpperCase() : "—"} />
      <Field k="修改时间" v={m ? formatLocal(m.mtimeNs / 1e6) : "—"} cls="mono" />
      <Field
        k="拍摄时间"
        v={taken}
        cls="mono"
        source={m?.takenSource ?? null}
      />
      <Field k="评分" v={stars} />
      <Field k="颜色标签" v="—" />

      <div className="insp-title">
        <span>相机与曝光</span>
        <Icon id="i-chev-down" size="xs" />
      </div>
      <Field k="相机" v={m?.camera ?? "—"} />
      <Field k="镜头" v={m?.lens ?? "—"} cls="mono" />
      <Field k="曝光" v={m?.exposure ?? "—"} cls="mono" />
      <Field k="ISO" v={m?.iso ?? "—"} cls="mono" />
      <Field k="焦距" v={m?.focal != null ? `${Math.round(m.focal)} mm` : "—"} cls="mono" />
      <Field
        k="方向"
        v={`已应用 (${m?.orientation ?? 1})`}
        source={m?.orientationSource ?? null}
      />

      <div className="insp-title">
        <span>XMP</span>
        <span className="src-tag">dc / xmp</span>
      </div>
      <Field k="标题" v={m?.title ?? "—"} />
      <Field k="关键词" v={m?.keywords.length ? m.keywords.join(", ") : "—"} />
      <Field k="版权" v={m?.rights ?? "—"} />
      <Field
        k="评级来源"
        v={m?.ratingSource ? "xmp:Rating" : "—"}
        source={m?.ratingSource ?? null}
      />
      <div className="hint">
        EXIF 与 XMP 冲突时以 XMP 为准（MWG 合并）；缺失拍摄时间则回退文件时间并标为「推断」。
      </div>

      <div className="insp-title">
        <span>直方图</span>
        <Icon id="i-chev-down" size="xs" />
      </div>
      {m ? (
        <>
          <HistogramChart meta={m} />
          <div className="hint" style={{ marginTop: "var(--ds-space-2)" }}>
            已按 sRGB 转换后统计；裁切区域外仍计入。
          </div>
        </>
      ) : (
        <div className="hist" />
      )}

      <div className="insp-title">
        <span>标签</span>
        <Icon id="i-plus" size="xs" />
      </div>
      <div className="tagrow">
        {m?.keywords.map((t) => (
          <span className="chip" key={t}>
            {t}
          </span>
        ))}
        <span className="chip add" aria-disabled="true" title="标签编辑随 M6 非破坏性编辑提供">
          + 添加
        </span>
      </div>

      <div className="insp-title">
        <span>位置</span>
        <Icon id="i-chev-down" size="xs" />
      </div>
      <Field
        k="坐标"
        v={m?.gps ? `${m.gps.lat.toFixed(4)}, ${m.gps.lon.toFixed(4)}` : "—"}
        cls="mono"
      />
      <Field k="地点" v="—" />
    </div>
  );
}
