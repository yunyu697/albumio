//! 批量处理（04-项目计划 M7 / 屏 4）：规划输出名与尺寸 → 逐条解码 / 方向 / sRGB /
//! 缩放 / 编码 → 临时文件落盘后改名。
//!
//! 两条硬规则（`04-项目计划.md` M7 验收）：
//! - **不覆盖**：目标与源文件同路径、或目标已存在时，自动追加 `_1`、`_2`；
//! - **失败逐条可读**：单条失败只记原因，不中断整批；取消只停在文件边界，
//!   已写出的文件有效，未完成的 `.part` 会被清掉。

use crate::thumb::{fit_dims, resize_rgba};
use crate::{color, decode, encode, orient, probe, Error, ImageFormat, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

/// 前端列表里的一项。`date` / `time` 由前端按本地时区格式化（`YYYYMMDD` / `HHMMSS`），
/// `camera` 来自已加载的元数据；缺失时占位符展开为空串。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchSource {
    pub path: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub camera: String,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub time: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOptions {
    /// 输出目录；空串表示输出到各自的源目录。
    #[serde(default)]
    pub out_dir: String,
    #[serde(default)]
    pub rename: bool,
    #[serde(default)]
    pub pattern: String,
    /// 格式转换开关；关闭时保留源格式。
    #[serde(default)]
    pub convert: bool,
    /// `keep` / `jpeg` / `png` / `webp`
    #[serde(default = "default_format")]
    pub format: String,
    /// 60–100（`02-设计规范.md` §11.5 的质量滑杆）
    #[serde(default = "default_quality")]
    pub quality: u8,
    /// `none` / `long2048` / `long1280` / `percent50`
    #[serde(default = "default_resize")]
    pub resize: String,
}

fn default_format() -> String {
    "keep".into()
}
fn default_quality() -> u8 {
    90
}
fn default_resize() -> String {
    "none".into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutFormat {
    Jpeg,
    Png,
    WebP,
}

impl OutFormat {
    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "jpeg" | "jpg" => Some(Self::Jpeg),
            "png" => Some(Self::Png),
            "webp" => Some(Self::WebP),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Jpeg => "jpeg",
            Self::Png => "png",
            Self::WebP => "webp",
        }
    }

    fn ext(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::WebP => "webp",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Jpeg => "JPEG",
            Self::Png => "PNG",
            Self::WebP => "WebP",
        }
    }

    fn estimate_bytes(self, w: u32, h: u32, quality: u8) -> u64 {
        let px = w as u64 * h as u64;
        let q = quality.max(1) as u64;
        match self {
            // 照片的经验值：q90 约 0.45 B/px；质量按线性近似，只用于"预估总量"。
            Self::Jpeg => px * 45 / 100 * q / 90,
            Self::Png => px * 15 / 10,
            Self::WebP => px * 30 / 100 * q / 90,
        }
        .max(1024)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Resize {
    None,
    Long(u32),
    Percent(u32),
}

impl Resize {
    fn parse(s: &str) -> Result<Self> {
        match s {
            "none" => Ok(Self::None),
            "long2048" => Ok(Self::Long(2048)),
            "long1280" => Ok(Self::Long(1280)),
            "percent50" => Ok(Self::Percent(50)),
            other => Err(Error::Invalid(format!("未知的尺寸调整：{other}"))),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::None => "原尺寸",
            Self::Long(2048) => "长边 2048",
            Self::Long(_) => "长边 1280",
            Self::Percent(50) => "50%",
            Self::Percent(_) => "按比例",
        }
    }

    fn apply(self, w: u32, h: u32) -> (u32, u32) {
        if w == 0 || h == 0 {
            return (0, 0);
        }
        match self {
            Self::None => (w, h),
            // fit_dims 只缩不放（`01-方案文档.md` §1.3）。
            Self::Long(edge) => fit_dims(w, h, edge),
            Self::Percent(p) => (
                ((w as u64 * p as u64 + 50) / 100).max(1) as u32,
                ((h as u64 * p as u64 + 50) / 100).max(1) as u32,
            ),
        }
    }
}

/// 一条计划：输出路径、预计尺寸与实际编码参数都定下来，执行阶段不再做决策。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPlanItem {
    pub src: String,
    /// 源文件名（含扩展名）。
    pub name: String,
    pub out: String,
    pub out_name: String,
    /// 实际输出格式：`jpeg` / `png` / `webp`。
    pub format: String,
    pub source_format: String,
    /// 应用方向后的输出尺寸。
    pub width: u32,
    pub height: u32,
    pub quality: u8,
    /// 因同名而追加了 `_1`、`_2`。
    pub conflict: bool,
    /// 计划期就能确定要跳过的原因。
    pub skip: Option<String>,
    /// 预估输出体积（只用于底部汇总）。
    pub est_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchPlan {
    pub items: Vec<BatchPlanItem>,
    pub out_dir: String,
    pub total: usize,
    pub conflicts: usize,
    pub skipped: usize,
    pub est_bytes: u64,
    /// "12 个文件 · JPEG · 长边 2048"（底部摘要左半）。
    pub summary: String,
}

/// 规划：只读文件头与 EXIF 方向，不解码像素。
pub fn plan(sources: &[BatchSource], opts: &BatchOptions) -> Result<BatchPlan> {
    let resize = Resize::parse(&opts.resize)?;
    let quality = opts.quality.clamp(60, 100);
    let requested = if opts.convert {
        match OutFormat::from_name(&opts.format) {
            Some(f) => Some(f),
            None if opts.format == "keep" => None,
            None => return Err(Error::Invalid(format!("未知的目标格式：{}", opts.format))),
        }
    } else {
        None
    };
    if opts.rename && opts.pattern.trim().is_empty() {
        return Err(Error::Invalid("重命名模板不能为空".into()));
    }

    let total = sources.len();
    let seq_width = total.max(1).to_string().len();
    let fixed_out = opts.out_dir.trim();
    let mut reserved: HashSet<String> = HashSet::new();
    let mut items = Vec::with_capacity(total);
    let mut conflicts = 0usize;
    let mut skipped = 0usize;
    let mut est_bytes = 0u64;
    let mut formats: HashSet<String> = HashSet::new();

    for (i, s) in sources.iter().enumerate() {
        let src = PathBuf::from(&s.path);
        let src_name = if s.name.trim().is_empty() {
            src.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            s.name.clone()
        };
        let stem = src
            .file_stem()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "image".into());

        let fmt = probe_path(&src);
        let out_format = match (requested, fmt) {
            (Some(f), _) => f,
            (None, Some(f)) => keep_format(f),
            (None, None) => OutFormat::Jpeg,
        };
        let orientation = orientation_of(&src);
        let (sw, sh) = source_dims(s, &src, fmt);
        let (ow, oh) = if (5..=8).contains(&orientation) {
            (sh, sw)
        } else {
            (sw, sh)
        };
        let (tw, th) = resize.apply(ow, oh);

        let out_dir = if fixed_out.is_empty() {
            src.parent().map(Path::to_path_buf).unwrap_or_default()
        } else {
            PathBuf::from(fixed_out)
        };

        let renamed = if opts.rename {
            let ctx = RenameCtx {
                stem: &stem,
                seq: i + 1,
                seq_width,
                camera: &s.camera,
                date: &s.date,
                time: &s.time,
                width: ow,
                height: oh,
            };
            sanitize_name(&expand_pattern(&opts.pattern, &ctx))
        } else {
            String::new()
        };
        let base = if renamed.is_empty() {
            stem.clone()
        } else {
            renamed
        };
        let desired_name = format!("{base}.{}", out_format.ext());
        let desired_path = out_dir.join(&desired_name);

        let pixel_change = out_format != keep_format_of(fmt) || resize != Resize::None;
        let name_change = !same_name(&desired_name, &src_name);
        if !pixel_change && !name_change && same_path(&desired_path, &src) {
            items.push(BatchPlanItem {
                src: src.display().to_string(),
                name: src_name,
                out: desired_path.display().to_string(),
                out_name: desired_name,
                format: out_format.name().into(),
                source_format: fmt.map(format_name).unwrap_or("unknown").to_string(),
                width: tw,
                height: th,
                quality,
                conflict: false,
                skip: Some("无需处理（输出与源文件相同）".into()),
                est_bytes: 0,
            });
            skipped += 1;
            continue;
        }

        let (final_name, conflict) = unique_name(&out_dir, &base, out_format, &src, &mut reserved);
        let final_path = out_dir.join(&final_name);
        let bytes = if tw == 0 || th == 0 {
            0
        } else {
            out_format.estimate_bytes(tw, th, quality)
        };
        if conflict {
            conflicts += 1;
        }
        est_bytes += bytes;
        formats.insert(out_format.label().to_string());
        items.push(BatchPlanItem {
            src: src.display().to_string(),
            name: src_name,
            out: final_path.display().to_string(),
            out_name: final_name,
            format: out_format.name().into(),
            source_format: fmt.map(format_name).unwrap_or("unknown").to_string(),
            width: tw,
            height: th,
            quality,
            conflict,
            skip: None,
            est_bytes: bytes,
        });
    }

    let fmt_label = if formats.len() == 1 {
        formats.into_iter().next().unwrap_or_default()
    } else if formats.is_empty() {
        "—".to_string()
    } else {
        "混合格式".to_string()
    };
    let size_label = if resize == Resize::None {
        Resize::None.label()
    } else {
        resize.label()
    };
    Ok(BatchPlan {
        summary: format!("{total} 个文件 · {fmt_label} · {size_label}"),
        items,
        out_dir: fixed_out.to_string(),
        total,
        conflicts,
        skipped,
        est_bytes,
    })
}

/* ---------------- 执行 ---------------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchItemResult {
    pub src: String,
    pub out: Option<String>,
    /// `done` / `skipped` / `failed`
    pub status: String,
    pub reason: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub bytes: Option<u64>,
    pub format: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchProgress {
    pub index: usize,
    pub total: usize,
    /// `begin`（开始处理某条）/ `item`（某条有结果）
    pub phase: &'static str,
    pub result: Option<BatchItemResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOutcome {
    pub cancelled: bool,
    pub results: Vec<BatchItemResult>,
}

/// 逐条执行。取消只在文件边界生效：正在写的文件会写完，已完成的文件保持有效。
pub fn run(
    plan: &BatchPlan,
    cancel: &AtomicBool,
    mut on_progress: impl FnMut(BatchProgress),
) -> BatchOutcome {
    let total = plan.items.len();
    let mut results = Vec::with_capacity(total);
    let mut cancelled = false;

    for (i, item) in plan.items.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            cancelled = true;
            break;
        }
        on_progress(BatchProgress {
            index: i,
            total,
            phase: "begin",
            result: None,
        });
        let result = match &item.skip {
            Some(reason) => BatchItemResult {
                src: item.src.clone(),
                out: None,
                status: "skipped".into(),
                reason: Some(reason.clone()),
                width: None,
                height: None,
                bytes: None,
                format: None,
            },
            None => match process_item(item) {
                Ok((w, h, bytes, fmt)) => BatchItemResult {
                    src: item.src.clone(),
                    out: Some(item.out.clone()),
                    status: "done".into(),
                    reason: None,
                    width: Some(w),
                    height: Some(h),
                    bytes: Some(bytes),
                    format: Some(fmt.name().into()),
                },
                Err(reason) => BatchItemResult {
                    src: item.src.clone(),
                    out: None,
                    status: "failed".into(),
                    reason: Some(reason),
                    width: None,
                    height: None,
                    bytes: None,
                    format: None,
                },
            },
        };
        results.push(result.clone());
        on_progress(BatchProgress {
            index: i,
            total,
            phase: "item",
            result: Some(result),
        });
    }

    if cancel.load(Ordering::Relaxed) && results.len() < total {
        cancelled = true;
    }
    BatchOutcome { cancelled, results }
}

fn process_item(item: &BatchPlanItem) -> std::result::Result<(u32, u32, u64, OutFormat), String> {
    let src = Path::new(&item.src);
    let format = OutFormat::from_name(&item.format)
        .ok_or_else(|| format!("未知的目标格式：{}", item.format))?;
    let (tw, th) = (item.width, item.height);
    if tw == 0 || th == 0 {
        return Err("源文件尺寸未知，无法处理".into());
    }

    // 解码到"目标长边 × 2"即可：JPEG 走分数解码，之后 Lanczos3 重采样到精确尺寸。
    let long = tw.max(th).max(1);
    let decoded =
        decode::decode_file(src, Some(long)).map_err(|e| format!("源文件不可读（{e}）"))?;
    let (mut rgba, w0, h0) = orient::apply_orientation(
        decoded.rgba,
        decoded.width,
        decoded.height,
        decoded.orientation,
    );
    color::to_srgb(&mut rgba, decoded.icc.as_deref()).map_err(|e| format!("色彩转换失败：{e}"))?;
    let rgba = resize_rgba(&rgba, w0, h0, tw, th).map_err(|e| format!("缩放失败：{e}"))?;

    let mut bytes = match format {
        OutFormat::Jpeg => encode::encode_jpeg(&rgba, tw, th, item.quality),
        OutFormat::Png => encode::encode_png(&rgba, tw, th),
        OutFormat::WebP => encode::encode_webp(&rgba, tw, th, item.quality),
    }
    .map_err(|e| format!("编码失败：{e}"))?;

    if format == OutFormat::Jpeg {
        let mut extra = Vec::new();
        if let Some(mut exif) = read_exif_segment(src) {
            // 像素已经按方向转正，EXIF 里的 Orientation 必须归零，否则查看器会再转一次。
            patch_orientation_to_1(&mut exif);
            add_jpeg_segment(&mut extra, 0xE1, &exif);
        }
        if let Some(icc) = srgb_icc() {
            let mut payload = Vec::with_capacity(14 + icc.len());
            payload.extend_from_slice(b"ICC_PROFILE\0");
            payload.push(1);
            payload.push(1);
            payload.extend_from_slice(icc);
            add_jpeg_segment(&mut extra, 0xE2, &payload);
        }
        bytes = insert_after_soi(bytes, &extra).map_err(|e| format!("编码失败：{e}"))?;
    }

    let out = Path::new(&item.out);
    write_atomic(out, &bytes).map_err(|e| format!("写入失败：{e}"))?;
    Ok((tw, th, bytes.len() as u64, format))
}

/* ---------------- 命名 ---------------- */

struct RenameCtx<'a> {
    stem: &'a str,
    seq: usize,
    seq_width: usize,
    camera: &'a str,
    date: &'a str,
    time: &'a str,
    width: u32,
    height: u32,
}

fn expand_pattern(pattern: &str, ctx: &RenameCtx) -> String {
    let mut out = String::new();
    let mut rest = pattern;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(end) = after.find('}') else {
            out.push_str(after);
            return out;
        };
        let token = &after[1..end];
        match token {
            "日期" => out.push_str(ctx.date),
            "时间" => out.push_str(ctx.time),
            "序号" => out.push_str(&format!("{:0width$}", ctx.seq, width = ctx.seq_width)),
            "原名" => out.push_str(ctx.stem),
            "相机" => out.push_str(ctx.camera),
            "宽" => out.push_str(&ctx.width.to_string()),
            "高" => out.push_str(&ctx.height.to_string()),
            _ => out.push_str(&after[..=end]),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// Windows 文件名的硬约束：非法字符、结尾空格/点、保留设备名。
fn sanitize_name(raw: &str) -> String {
    let mut out: String = raw
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .collect();
    out = out.trim_end_matches([' ', '.']).to_string();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&out.to_uppercase().as_str()) {
        out.push('_');
    }
    out.trim().to_string()
}

/// 同名时追加 `_1`、`_2`；与源文件同路径、或磁盘上已存在，都算冲突（绝不覆盖）。
fn unique_name(
    out_dir: &Path,
    base: &str,
    format: OutFormat,
    src: &Path,
    reserved: &mut HashSet<String>,
) -> (String, bool) {
    let mut n = 0usize;
    loop {
        let name = if n == 0 {
            format!("{base}.{}", format.ext())
        } else {
            format!("{base}_{n}.{}", format.ext())
        };
        let path = out_dir.join(&name);
        let key = path.to_string_lossy().to_lowercase();
        if !reserved.contains(&key) && !same_path(&path, src) && !path.exists() {
            reserved.insert(key);
            return (name, n > 0);
        }
        n += 1;
    }
}

fn same_name(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    if let (Ok(a), Ok(b)) = (fs::canonicalize(a), fs::canonicalize(b)) {
        return a == b;
    }
    let norm = |p: &Path| {
        let s = p.to_string_lossy().replace('/', "\\");
        if cfg!(windows) {
            s.to_lowercase()
        } else {
            s
        }
    };
    norm(a) == norm(b)
}

/* ---------------- 文件与编码细节 ---------------- */

fn probe_path(path: &Path) -> Option<ImageFormat> {
    let mut head = [0u8; 64];
    let n = fs::File::open(path)
        .and_then(|mut f| f.read(&mut head))
        .ok()?;
    probe::probe_bytes(&head[..n])
}

fn source_dims(s: &BatchSource, path: &Path, fmt: Option<ImageFormat>) -> (u32, u32) {
    if s.width > 0 && s.height > 0 {
        return (s.width, s.height);
    }
    let dims = image::ImageReader::open(path)
        .ok()
        .and_then(|r| r.with_guessed_format().ok())
        .and_then(|r| r.into_dimensions().ok())
        .or_else(|| fmt.and_then(|f| decode::platform_dims(path, f)));
    dims.unwrap_or((0, 0))
}

fn orientation_of(path: &Path) -> u8 {
    let Ok(file) = fs::File::open(path) else {
        return 1;
    };
    let Ok(exif) = exif::Reader::new().read_from_container(&mut std::io::BufReader::new(file))
    else {
        return 1;
    };
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .map(|v| v as u8)
        .filter(|v| (1..=8).contains(v))
        .unwrap_or(1)
}

fn keep_format(f: ImageFormat) -> OutFormat {
    match f {
        ImageFormat::Png => OutFormat::Png,
        ImageFormat::WebP => OutFormat::WebP,
        // HEIC/AVIF/RAW/TIFF/BMP/GIF：批量输出统一回退 JPEG（设计稿只给 JPEG/PNG/WebP）。
        _ => OutFormat::Jpeg,
    }
}

fn keep_format_of(f: Option<ImageFormat>) -> OutFormat {
    f.map(keep_format).unwrap_or(OutFormat::Jpeg)
}

fn format_name(f: ImageFormat) -> &'static str {
    match f {
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::Png => "png",
        ImageFormat::Tiff => "tiff",
        ImageFormat::Bmp => "bmp",
        ImageFormat::WebP => "webp",
        ImageFormat::Gif => "gif",
        ImageFormat::Heic => "heic",
        ImageFormat::Avif => "avif",
        ImageFormat::Raw => "raw",
    }
}

fn write_atomic(out: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut part = out.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    let result = fs::write(&part, bytes).and_then(|_| fs::rename(&part, out));
    if result.is_err() {
        let _ = fs::remove_file(&part);
    }
    result.map_err(Error::from)
}

/// 取源 JPEG 的 APP1 Exif 段（含 `Exif\0\0`）。只读前 512 KB，足够覆盖元数据。
fn read_exif_segment(path: &Path) -> Option<Vec<u8>> {
    let mut buf = vec![0u8; 512 * 1024];
    let mut f = fs::File::open(path).ok()?;
    let n = f.read(&mut buf).ok()?;
    let b = &buf[..n];
    if !b.starts_with(&[0xFF, 0xD8]) {
        return None;
    }
    let mut i = 2usize;
    while i + 4 <= b.len() {
        if b[i] != 0xFF {
            return None;
        }
        let marker = b[i + 1];
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        if len < 2 || i + 2 + len > b.len() {
            return None;
        }
        let seg = &b[i + 4..i + 2 + len];
        if marker == 0xE1 && seg.starts_with(b"Exif\0\0") {
            return Some(seg.to_vec());
        }
        i += 2 + len;
    }
    None
}

/// 把 IFD0 里的 Orientation 改成 1（像素已转正）。
fn patch_orientation_to_1(payload: &mut [u8]) {
    if payload.len() < 14 || !payload.starts_with(b"Exif\0\0") {
        return;
    }
    let tiff = &mut payload[6..];
    let little = match &tiff[0..2] {
        b"II" => true,
        b"MM" => false,
        _ => return,
    };
    let u16_at = |b: &[u8], off: usize| {
        if little {
            u16::from_le_bytes([b[off], b[off + 1]])
        } else {
            u16::from_be_bytes([b[off], b[off + 1]])
        }
    };
    let u32_at = |b: &[u8], off: usize| {
        if little {
            u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
        } else {
            u32::from_be_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]])
        }
    };
    if tiff.len() < 8 || u16_at(tiff, 2) != 42 {
        return;
    }
    let ifd = u32_at(tiff, 4) as usize;
    if ifd + 2 > tiff.len() {
        return;
    }
    let count = u16_at(tiff, ifd) as usize;
    for k in 0..count {
        let e = ifd + 2 + k * 12;
        if e + 12 > tiff.len() {
            return;
        }
        if u16_at(tiff, e) == 0x0112 && u16_at(tiff, e + 2) == 3 {
            // SHORT 值占 4 字节值槽的前 2 字节（按 TIFF 字节序）。
            if little {
                tiff[e + 8] = 1;
                tiff[e + 9] = 0;
            } else {
                tiff[e + 8] = 0;
                tiff[e + 9] = 1;
            }
            return;
        }
    }
}

fn add_jpeg_segment(buf: &mut Vec<u8>, marker: u8, payload: &[u8]) {
    if payload.len() + 2 > u16::MAX as usize {
        return;
    }
    buf.push(0xFF);
    buf.push(marker);
    buf.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    buf.extend_from_slice(payload);
}

fn insert_after_soi(jpeg: Vec<u8>, extra: &[u8]) -> Result<Vec<u8>> {
    if extra.is_empty() {
        return Ok(jpeg);
    }
    if jpeg.len() < 2 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return Err(Error::Encode("JPEG 头不合法".into()));
    }
    let mut out = Vec::with_capacity(jpeg.len() + extra.len());
    out.extend_from_slice(&jpeg[..2]);
    out.extend_from_slice(extra);
    out.extend_from_slice(&jpeg[2..]);
    Ok(out)
}

/// 输出像素已统一转 sRGB，把标准 sRGB profile 嵌进 JPEG（`02-设计规范.md` §11.5）。
fn srgb_icc() -> Option<&'static [u8]> {
    static ICC: OnceLock<Option<Vec<u8>>> = OnceLock::new();
    ICC.get_or_init(|| lcms2::Profile::new_srgb().icc().ok())
        .as_deref()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>(stem: &'a str, camera: &'a str, date: &'a str, time: &'a str) -> RenameCtx<'a> {
        RenameCtx {
            stem,
            seq: 7,
            seq_width: 3,
            camera,
            date,
            time,
            width: 6000,
            height: 4000,
        }
    }

    #[test]
    fn template_expands_all_placeholders() {
        let c = ctx("DSC_0482", "Sony A7M4", "20240512", "083107");
        assert_eq!(
            expand_pattern("{日期}_{时间}_{序号}_{原名}_{相机}_{宽}x{高}", &c),
            "20240512_083107_007_DSC_0482_Sony A7M4_6000x4000"
        );
    }

    #[test]
    fn unknown_placeholder_is_kept_verbatim() {
        let c = ctx("a", "", "", "");
        assert_eq!(expand_pattern("{原名}_{未知}", &c), "a_{未知}");
    }

    #[test]
    fn sanitize_handles_windows_limits() {
        assert_eq!(sanitize_name("a:b*c?. "), "a_b_c_");
        assert_eq!(sanitize_name("CON"), "CON_");
        assert_eq!(sanitize_name(" 京都 "), "京都");
    }

    #[test]
    fn resize_never_upscales() {
        assert_eq!(Resize::Long(2048).apply(1000, 800), (1000, 800));
        assert_eq!(Resize::Long(2048).apply(4000, 3000), (2048, 1536));
        assert_eq!(Resize::Percent(50).apply(101, 51), (51, 26));
    }
}
