//! 解码：JPEG 走 zune-jpeg（全解码）/ jpeg-decoder（分数缩放解码），其余走 `image`；
//! Windows 上 HEIC/AVIF/RAW 走系统 WIC（`docs/spike/S2-decoders.md`）；
//! macOS/Linux 的 HEIC 走内置 libheif（M9 决策），AVIF/RAW 仍返回可判定的 Unsupported。

use crate::{Error, ImageFormat, Result};
use std::io::Cursor;
use std::path::Path;

/// Windows 上这三类格式交给 WIC；macOS/Linux 只有 HEIC 走内置 libheif。
pub fn uses_platform_codec(format: ImageFormat) -> bool {
    cfg!(windows) && matches!(format, ImageFormat::Heic | ImageFormat::Avif | ImageFormat::Raw)
}

/// 平台解码器能给的尺寸（WIC 读帧头，不解码像素）。非平台格式返回 `None`。
pub fn platform_dims(path: &Path, format: ImageFormat) -> Option<(u32, u32)> {
    #[cfg(windows)]
    if uses_platform_codec(format) {
        return crate::wic::dims(path);
    }
    let _ = (path, format);
    None
}

#[derive(Debug)]
pub struct DecodedImage {
    pub format: ImageFormat,
    /// 解码后的原始方向尺寸（Orientation 尚未应用）
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub orientation: u8,
    pub icc: Option<Vec<u8>>,
}

/// 解码。`target_edge` 为长边目标（用于 JPEG 分数缩放解码），`None` 表示全尺寸。
pub fn decode_bytes(
    bytes: &[u8],
    format: ImageFormat,
    target_edge: Option<u32>,
) -> Result<DecodedImage> {
    let orientation = read_orientation(bytes, format);
    match format {
        ImageFormat::Jpeg => decode_jpeg(bytes, target_edge, orientation),
        ImageFormat::Heic => {
            #[cfg(not(target_os = "windows"))]
            {
                decode_heic(bytes)
            }
            #[cfg(target_os = "windows")]
            {
                Err(Error::Unsupported {
                    format,
                    reason: "Windows 上 HEIC 走系统 WIC（decode_file）".to_string(),
                })
            }
        }
        ImageFormat::Avif | ImageFormat::Raw => Err(Error::Unsupported {
            format,
            reason: match format {
                ImageFormat::Avif => "dav1d 未接入（04-项目计划 M1）",
                _ => "rawler 未接入（04-项目计划 M1）",
            }
            .to_string(),
        }),
        _ => {
            let img_fmt = match format {
                ImageFormat::Png => image::ImageFormat::Png,
                ImageFormat::Tiff => image::ImageFormat::Tiff,
                ImageFormat::Bmp => image::ImageFormat::Bmp,
                ImageFormat::WebP => image::ImageFormat::WebP,
                ImageFormat::Gif => image::ImageFormat::Gif,
                other => return Err(Error::UnknownFormat(format!("{other:?}"))),
            };
            let img = image::load_from_memory_with_format(bytes, img_fmt)
                .map_err(|e| Error::Decode(e.to_string()))?;
            let rgba = img.to_rgba8();
            let (w, h) = (rgba.width(), rgba.height());
            Ok(DecodedImage {
                format,
                width: w,
                height: h,
                rgba: rgba.into_raw(),
                orientation,
                icc: read_icc(bytes, format),
            })
        }
    }
}

pub fn decode_file(path: &Path, target_edge: Option<u32>) -> Result<DecodedImage> {
    // 先读 64 字节判格式：HEIC 可能是几十 MB，不能为了探测整份读进内存。
    let mut head = [0u8; 64];
    let n = {
        use std::io::Read;
        let mut f = std::fs::File::open(path)?;
        f.read(&mut head)?
    };
    let format = crate::probe::probe_bytes(&head[..n])
        .ok_or_else(|| Error::UnknownFormat(path.display().to_string()))?;

    #[cfg(windows)]
    if uses_platform_codec(format) {
        return crate::wic::decode_path(path, format, target_edge);
    }

    let bytes = std::fs::read(path)?;
    decode_bytes(&bytes, format, target_edge)
}

/// HEIC：macOS/Linux 用内置 libheif 解码成 RGBA。libheif 会应用 irot/imir 与裁剪，
/// 所以 orientation 固定为 1（避免二次旋转）。色彩按文件内 nclx/sRGB 处理；
/// ICC 暂不抽取（HEIC 少见非 sRGB，后续需要时再补）。
#[cfg(not(target_os = "windows"))]
fn decode_heic(bytes: &[u8]) -> Result<DecodedImage> {
    use libheif_rs::{ColorSpace, HeifContext, LibHeif, RgbChroma};

    let ctx = HeifContext::read_from_bytes(bytes).map_err(|e| Error::Decode(e.to_string()))?;
    let handle = ctx
        .primary_image_handle()
        .map_err(|e| Error::Decode(e.to_string()))?;
    let (width, height) = (handle.width(), handle.height());
    // 2.x 里 `decode` 挂在 `LibHeif` 上（不是 `HeifContext`）。
    let image = LibHeif::new()
        .decode(&handle, ColorSpace::Rgb(RgbChroma::Rgba), None)
        .map_err(|e| Error::Decode(e.to_string()))?;
    let planes = image.planes();
    let plane = planes
        .interleaved
        .ok_or_else(|| Error::Decode("HEIC 解码结果没有交错 RGBA 平面".into()))?;

    let row_bytes = width as usize * 4;
    let mut rgba = Vec::with_capacity(row_bytes * height as usize);
    for y in 0..height as usize {
        let start = y * plane.stride;
        let end = start + row_bytes;
        if end > plane.data.len() {
            return Err(Error::Decode("HEIC 平面尺寸与宽高不一致".into()));
        }
        rgba.extend_from_slice(&plane.data[start..end]);
    }

    Ok(DecodedImage {
        format: ImageFormat::Heic,
        width,
        height,
        rgba,
        orientation: 1,
        icc: None,
    })
}

fn decode_jpeg(bytes: &[u8], target_edge: Option<u32>, orientation: u8) -> Result<DecodedImage> {
    if let Some(edge) = target_edge {
        if let Ok(img) = decode_jpeg_scaled(bytes, edge, orientation) {
            return Ok(img);
        }
    }
    decode_jpeg_zune(bytes, orientation)
}

/// 分数缩放解码（1/8、1/4、1/2、1），用于 L0/L1 与大图（`01-方案文档.md` §1.2）。
fn decode_jpeg_scaled(bytes: &[u8], target_edge: u32, orientation: u8) -> Result<DecodedImage> {
    use jpeg_decoder::PixelFormat as Pf;
    let mut dec = jpeg_decoder::Decoder::new(Cursor::new(bytes));
    dec.read_info().map_err(|e| Error::Decode(e.to_string()))?;
    let (ow, oh) = {
        let info = dec
            .info()
            .ok_or_else(|| Error::Decode("JPEG 头缺失".into()))?;
        (info.width as u32, info.height as u32)
    };
    // 只在确实能降档时用分数解码，避免小图被无谓重采样。
    if ow.max(oh) <= target_edge * 2 {
        return Err(Error::Invalid("不需要分数解码".into()));
    }
    let want = (target_edge * 2).min(u16::MAX as u32) as u16;
    dec.scale(want, want)
        .map_err(|e| Error::Decode(e.to_string()))?;
    let pixels = dec.decode().map_err(|e| Error::Decode(e.to_string()))?;
    let info = dec
        .info()
        .ok_or_else(|| Error::Decode("JPEG 头缺失".into()))?;
    let (w, h) = (info.width as u32, info.height as u32);

    let rgba = match info.pixel_format {
        Pf::RGB24 => rgb_to_rgba(&pixels),
        Pf::L8 => luma_to_rgba(&pixels),
        Pf::CMYK32 => cmyk_to_rgba(&pixels),
        other => return Err(Error::Decode(format!("不支持的 JPEG 像素格式：{other:?}"))),
    };
    Ok(DecodedImage {
        format: ImageFormat::Jpeg,
        width: w,
        height: h,
        rgba,
        orientation,
        icc: read_icc(bytes, ImageFormat::Jpeg),
    })
}

fn decode_jpeg_zune(bytes: &[u8], orientation: u8) -> Result<DecodedImage> {
    use zune_jpeg::zune_core::bytestream::ZCursor;
    use zune_jpeg::zune_core::colorspace::ColorSpace;
    use zune_jpeg::JpegDecoder;

    let mut dec = JpegDecoder::new(ZCursor::new(bytes));
    dec.decode_headers()
        .map_err(|e| Error::Decode(e.to_string()))?;
    let space = dec
        .output_colorspace()
        .ok_or_else(|| Error::Decode("JPEG 输出色彩空间未知".into()))?;

    let pixels = dec.decode().map_err(|e| Error::Decode(e.to_string()))?;
    let (w, h) = dec
        .dimensions()
        .ok_or_else(|| Error::Decode("JPEG 尺寸未知".into()))?;

    let rgba = match space {
        ColorSpace::RGB => rgb_to_rgba(&pixels),
        ColorSpace::Luma => luma_to_rgba(&pixels),
        ColorSpace::CMYK | ColorSpace::YCCK => cmyk_to_rgba(&pixels),
        _ => return Err(Error::Decode("JPEG 输出色彩空间不支持".into())),
    };
    Ok(DecodedImage {
        format: ImageFormat::Jpeg,
        width: w as u32,
        height: h as u32,
        rgba,
        orientation,
        icc: read_icc(bytes, ImageFormat::Jpeg),
    })
}

fn rgb_to_rgba(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len() / 3 * 4);
    for px in src.chunks_exact(3) {
        out.extend_from_slice(&[px[0], px[1], px[2], 255]);
    }
    out
}

fn luma_to_rgba(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len() * 4);
    for &v in src {
        out.extend_from_slice(&[v, v, v, 255]);
    }
    out
}

/// Adobe CMYK：存的是反相值，所以 R = C·K/255（C 为原始字节）。
fn cmyk_to_rgba(src: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(src.len() / 4 * 4);
    for px in src.chunks_exact(4) {
        let c = px[0] as u32;
        let m = px[1] as u32;
        let y = px[2] as u32;
        let k = px[3] as u32;
        out.push(((c * k) / 255) as u8);
        out.push(((m * k) / 255) as u8);
        out.push(((y * k) / 255) as u8);
        out.push(255);
    }
    out
}

/// 读 EXIF Orientation（1..=8），读不到按 1 处理。
pub fn read_orientation(bytes: &[u8], format: ImageFormat) -> u8 {
    if !matches!(format, ImageFormat::Jpeg | ImageFormat::Tiff) {
        return 1;
    }
    let mut cursor = Cursor::new(bytes);
    let exif = match exif::Reader::new().read_from_container(&mut cursor) {
        Ok(e) => e,
        Err(_) => return 1,
    };
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .map(|v| v as u8)
        .filter(|v| (1..=8).contains(v))
        .unwrap_or(1)
}

/// 抽 ICC profile（`01-方案文档.md` §1.2：色彩只在 Rust 转一次）。
pub fn read_icc(bytes: &[u8], format: ImageFormat) -> Option<Vec<u8>> {
    use image::ImageDecoder;
    let mut cursor = Cursor::new(bytes);
    let icc = match format {
        ImageFormat::Jpeg => {
            let mut d = image::codecs::jpeg::JpegDecoder::new(&mut cursor).ok()?;
            d.icc_profile().ok().flatten()
        }
        ImageFormat::Png => {
            let mut d = image::codecs::png::PngDecoder::new(&mut cursor).ok()?;
            d.icc_profile().ok().flatten()
        }
        ImageFormat::WebP => webp_icc(bytes),
        _ => None,
    };
    icc.filter(|v| !v.is_empty())
}

fn webp_icc(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }
    let mut pos = 12usize;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        let body = pos + 8;
        if body + len > bytes.len() {
            return None;
        }
        if id == b"ICCP" {
            return Some(bytes[body..body + len].to_vec());
        }
        pos = body + len + (len & 1);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broken_jpeg_errors_instead_of_panicking() {
        let bytes = [
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', 0, 1, 1, 0, 0, 0, 0, 0,
        ];
        assert!(decode_bytes(&bytes, ImageFormat::Jpeg, None).is_err());
    }

    #[test]
    fn broken_heic_errors_instead_of_panicking() {
        // 空字节不是合法 ISOBMFF：Windows 走 WIC 前的 decode_bytes 分支应报 Unsupported，
        // macOS/Linux 由 libheif 报解码错误——两边都必须是 Err，不能 panic。
        assert!(decode_bytes(&[], ImageFormat::Heic, None).is_err());
    }

    #[test]
    fn webp_iccp_chunk_is_extracted() {
        let profile = b"fake-icc";
        let mut chunk = Vec::new();
        chunk.extend_from_slice(b"ICCP");
        chunk.extend_from_slice(&(profile.len() as u32).to_le_bytes());
        chunk.extend_from_slice(profile);
        chunk.push(0); // 对齐位
        let mut riff = Vec::new();
        riff.extend_from_slice(b"RIFF");
        riff.extend_from_slice(&((4 + chunk.len()) as u32).to_le_bytes());
        riff.extend_from_slice(b"WEBP");
        riff.extend_from_slice(&chunk);
        assert_eq!(webp_icc(&riff).as_deref(), Some(&profile[..]));
    }
}
