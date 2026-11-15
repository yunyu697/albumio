//! 管线入口：探测 → 解码 → 方向 → sRGB → 编码 → 缓存。

use crate::cache::{mtime_ns, Cache, Level};
use crate::encode::webp_dims;
use crate::thumb::{fit_dims, resize_rgba};
use crate::{color, decode, encode, orient, probe};
use crate::{Error, ImageFormat, Result, MAX_WEBVIEW_EDGE};
use serde::Serialize;
use std::fs;
use std::path::Path;
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
        let mut head = [0u8; 32];
        let n = {
            use std::io::Read;
            let mut f = fs::File::open(path)?;
            f.read(&mut head)?
        };
        let format = probe::probe_bytes(&head[..n])
            .ok_or_else(|| Error::UnknownFormat(path.display().to_string()))?;
        let dims = image::ImageReader::open(path)
            .ok()
            .and_then(|r| r.with_guessed_format().ok())
            .and_then(|r| r.into_dimensions().ok());
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

        let raw = fs::read(path)?;
        let format = probe::probe_bytes(&raw)
            .ok_or_else(|| Error::UnknownFormat(path.display().to_string()))?;
        let target = level.edge();
        // jpeg-decoder 会选"不小于请求值"的 DCT 档位（1/8…1），因此请求目标本身即可
        // 拿到约 2 倍目标宽的中间图，足够 Lanczos 重采样。
        let decoded = decode::decode_bytes(&raw, format, Some(target))?;

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
