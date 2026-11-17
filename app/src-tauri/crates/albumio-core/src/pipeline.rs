//! 管线入口：探测 → 解码 → 方向 → sRGB → 编码 → 缓存。

use crate::cache::{mtime_ns, Cache, Level};
use crate::edit::{apply_ops, EditStack};
use crate::encode::webp_dims;
use crate::thumb::{fit_dims, resize_rgba};
use crate::{color, decode, encode, orient, probe};
use crate::{Error, ImageFormat, Result, MAX_WEBVIEW_EDGE};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    pub path: String,
    pub format: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub size: u64,
    pub mtime_ns: i128,
}

#[derive(Debug, Clone)]
pub struct ThumbResult {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub key: String,
    pub cached: bool,
    pub elapsed_ms: u128,
}

pub struct Pipeline {
    cache: Cache,
}

impl Pipeline {
    pub fn new(cache_root: impl Into<std::path::PathBuf>) -> Result<Self> {
        Ok(Self {
            cache: Cache::new(cache_root)?,
        })
    }

    pub fn cache(&self) -> &Cache {
        &self.cache
    }

    pub fn probe(&self, path: &Path) -> Result<FileInfo> {
        let meta = fs::metadata(path)?;
        let format = probe::probe_file(path)?;
        // RAW 的 TIFF 头给的是传感器尺寸，和实际展示的内嵌预览对不上，宁可不给——
        // 缩略图解出来后界面会拿到真实宽高。
        let dims = if format == ImageFormat::Raw {
            None
        } else {
            image::ImageReader::open(path)
                .ok()
                .and_then(|r| r.with_guessed_format().ok())
                .and_then(|r| r.into_dimensions().ok())
        }
        // HEIC/AVIF 的尺寸只有平台解码器知道（WIC 读帧头，不申请像素缓冲）。
        .or_else(|| decode::platform_dims(path, format));
        Ok(FileInfo {
            path: path.display().to_string(),
            format: format_name(format),
            width: dims.map(|d| d.0),
            height: dims.map(|d| d.1),
            size: meta.len(),
            mtime_ns: mtime_ns(&meta),
        })
    }

    /// 生成或读取一级缩略图。命中缓存不做任何解码。
    pub fn thumbnail(&self, path: &Path, level: Level) -> Result<ThumbResult> {
        let t0 = Instant::now();
        let meta = fs::metadata(path)?;
        let key = Cache::key_for(path, meta.len(), mtime_ns(&meta));

        if let Some(bytes) = self.cache.read(level, &key) {
            if let Some((w, h)) = webp_dims(&bytes) {
                return Ok(ThumbResult {
                    bytes,
                    width: w,
                    height: h,
                    key,
                    cached: true,
                    elapsed_ms: t0.elapsed().as_millis(),
                });
            }
            // 缓存文件损坏：删掉重生成，不把坏图交给界面。
            self.cache.remove(level, &key);
        }

        // 判格式只需要文件头；HEIC 可能有几十 MB，不能为了探测整份读进来。
        let format = probe::probe_file(path)?;
        let target = level.edge();
        // jpeg-decoder 会选"不小于请求值"的 DCT 档位（1/8…1），因此请求目标本身即可
        // 拿到约 2 倍目标宽的中间图，足够 Lanczos 重采样。
        // HEIC/AVIF 走 WIC、RAW 走 rawler：都按文件解码，不把整份文件读进内存。
        let decoded = if decode::uses_platform_codec(format) || decode::needs_path(format) {
            decode::decode_file(path, Some(target))?
        } else {
            let raw = fs::read(path)?;
            decode::decode_bytes(&raw, format, Some(target))?
        };

        let rotated = matches!(decoded.orientation, 5..=8);
        let (oriented_w, oriented_h) = if rotated {
            (decoded.height, decoded.width)
        } else {
            (decoded.width, decoded.height)
        };
        let (tw, th) = fit_dims(oriented_w, oriented_h, target);
        let (rw, rh) = if rotated { (th, tw) } else { (tw, th) };

        let resized = resize_rgba(&decoded.rgba, decoded.width, decoded.height, rw, rh)?;
        let (mut rgba, w, h) = orient::apply_orientation(resized, rw, rh, decoded.orientation);
        color::to_srgb(&mut rgba, decoded.icc.as_deref())?;

        if w > MAX_WEBVIEW_EDGE || h > MAX_WEBVIEW_EDGE {
            return Err(Error::Invalid(format!(
                "缩略图边长 {w}×{h} 超过 WebView 上限 {MAX_WEBVIEW_EDGE}（docs/spike/S1.md）"
            )));
        }

        let webp = if level == Level::L0 {
            encode::encode_lossless(&rgba, w, h)?
        } else {
            encode::encode_q80(&rgba, w, h)?
        };
        self.cache.write(level, &key, &webp)?;

        Ok(ThumbResult {
            bytes: webp,
            width: w,
            height: h,
            key,
            cached: false,
            elapsed_ms: t0.elapsed().as_millis(),
        })
    }

    /// 启动时按预算淘汰 L1/L2。
    pub fn sweep(&self) -> Result<u64> {
        Ok(self.cache.sweep(Level::L1)? + self.cache.sweep(Level::L2)?)
    }

    /// 编辑预览：在已转过方向、已转 sRGB 的 L2 代理上执行 `apply_ops`，返回 WebP。
    /// 预览不重新解码原图——滑杆拖动时每秒可能请求十几次，原图解码扛不住。
    pub fn edit_preview(&self, path: &Path, stack: &EditStack) -> Result<Vec<u8>> {
        let l2 = self.thumbnail(path, Level::L2)?;
        let (rgba, w, h) = decode_webp(&l2.bytes)?;
        let out = apply_ops(rgba, w, h, stack)?;
        encode::encode_q80(&out.rgba, out.width, out.height)
    }

    /// 编辑预览的预览尺寸（前端用来把操作映射到屏幕坐标）。
    pub fn edit_preview_dims(&self, path: &Path) -> Result<(u32, u32)> {
        let l2 = self.thumbnail(path, Level::L2)?;
        Ok((l2.width, l2.height))
    }

    /// 导出副本：从原图全尺寸解码，走与预览同一段 `apply_ops`，编码 JPEG q90。
    /// 原图只读，不覆盖（`01-方案文档.md` §5.4）。
    pub fn export(&self, path: &Path, stack: &EditStack) -> Result<ExportResult> {
        let meta = fs::metadata(path)?;
        let format = probe::probe_file(path)?;
        let decoded = decode::decode_file(path, None)?;
        let (mut rgba, w, h) = orient::apply_orientation(
            decoded.rgba,
            decoded.width,
            decoded.height,
            decoded.orientation,
        );
        color::to_srgb(&mut rgba, decoded.icc.as_deref())?;
        let out = apply_ops(rgba, w, h, stack)?;
        let jpeg = encode::encode_jpeg_q90(&out.rgba, out.width, out.height)?;
        let target = export_target(path);
        fs::write(&target, &jpeg)?;
        Ok(ExportResult {
            path: target.display().to_string(),
            width: out.width,
            height: out.height,
            bytes: jpeg.len() as u64,
            format: format_name(format),
            source_size: meta.len(),
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
    pub format: String,
    /// 原图大小，前端用它证明原图未被改写。
    pub source_size: u64,
}

/// `原名_Albumio.jpg`，同名已存在时追加 `_1`、`_2`（`01-方案文档.md` §5.4）。
fn export_target(src: &Path) -> PathBuf {
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "export".into());
    let base = format!("{stem}_Albumio");
    let mut target = src.with_file_name(format!("{base}.jpg"));
    let mut n = 1;
    while target.exists() {
        target = src.with_file_name(format!("{base}_{n}.jpg"));
        n += 1;
    }
    target
}

/// 解码已缓存/已生成的 WebP 代理（预览与导出都只拿它当输入）。
fn decode_webp(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::WebP)
        .map_err(|e| Error::Decode(format!("L2 代理解码失败：{e}")))?;
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    Ok((rgba.into_raw(), w, h))
}

fn format_name(f: ImageFormat) -> String {
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
    .to_string()
}
