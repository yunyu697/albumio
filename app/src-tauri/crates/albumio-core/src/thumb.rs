//! 缩放与缩略图尺寸计算（`01-方案文档.md` §1.3 的三级）。

use crate::{Error, Result};
use fast_image_resize::{images::Image, PixelType, ResizeAlg, ResizeOptions, Resizer};

/// 按长边等比缩放，不放大。
pub fn fit_dims(w: u32, h: u32, max_edge: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (0, 0);
    }
    let long = w.max(h);
    if long <= max_edge {
        return (w, h);
    }
    let scale = max_edge as f64 / long as f64;
    let nw = ((w as f64 * scale).round() as u32).max(1);
    let nh = ((h as f64 * scale).round() as u32).max(1);
    (nw, nh)
}

/// RGBA8 缩放（Lanczos3，SIMD）。
pub fn resize_rgba(rgba: &[u8], w: u32, h: u32, tw: u32, th: u32) -> Result<Vec<u8>> {
    if w == 0 || h == 0 || tw == 0 || th == 0 {
        return Err(Error::Invalid("缩放尺寸为 0".into()));
    }
    if (w, h) == (tw, th) {
        return Ok(rgba.to_vec());
    }
    let src = Image::from_vec_u8(w, h, rgba.to_vec(), PixelType::U8x4)
        .map_err(|e| Error::Encode(e.to_string()))?;
    let mut dst = Image::new(tw, th, PixelType::U8x4);
    let mut resizer = Resizer::new();
    resizer
        .resize(
            &src,
            &mut dst,
            &ResizeOptions::new().resize_alg(ResizeAlg::Convolution(
                fast_image_resize::FilterType::Lanczos3,
            )),
        )
        .map_err(|e| Error::Encode(format!("缩放失败：{e}")))?;
    Ok(dst.into_vec())
}

/// L0 的取色：整图平均色（解码到 64 px 后求均值，风格上是"占位色块"）。
pub fn average_rgba(rgba: &[u8]) -> [u8; 4] {
    if rgba.is_empty() {
        return [0, 0, 0, 0];
    }
    let n = (rgba.len() / 4) as u64;
    if n == 0 {
        return [0, 0, 0, 0];
    }
    let mut acc = [0u64; 4];
    for px in rgba.chunks_exact(4) {
        for i in 0..4 {
            acc[i] += px[i] as u64;
        }
    }
    [
        (acc[0] / n) as u8,
        (acc[1] / n) as u8,
        (acc[2] / n) as u8,
        (acc[3] / n) as u8,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_keeps_aspect_and_never_upscales() {
        assert_eq!(fit_dims(6000, 4000, 256), (256, 171));
        assert_eq!(fit_dims(4000, 6000, 256), (171, 256));
        assert_eq!(fit_dims(100, 80, 256), (100, 80));
        assert_eq!(fit_dims(6000, 4000, 2048), (2048, 1365));
    }

    #[test]
    fn resize_produces_requested_size() {
        let src = vec![255u8; 4 * 8 * 8];
        let out = resize_rgba(&src, 8, 8, 4, 2).unwrap();
        assert_eq!(out.len(), 4 * 2 * 4);
    }

    #[test]
    fn average_matches_known_color() {
        let src = vec![10, 20, 30, 255, 20, 40, 60, 255];
        assert_eq!(average_rgba(&src), [15, 30, 45, 255]);
    }
}
