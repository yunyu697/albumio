//! WebP 编码：L0 无损（32px，< 1KB），L1/L2 q80 + `sharp_yuv`（`docs/spike/S3.md`）。

use crate::{Error, Result};

/// 无损 WebP（L0 占位）。
pub fn encode_lossless(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>> {
    let encoder = webp::Encoder::from_rgba(rgba, w, h);
    Ok(encoder.encode_lossless().to_vec())
}

/// 有损 WebP，固定 q80；`use_sharp_yuv` 减少 4:2:0 色度在硬边的彩边。
pub fn encode_q80(rgba: &[u8], w: u32, h: u32) -> Result<Vec<u8>> {
    let encoder = webp::Encoder::from_rgba(rgba, w, h);
    let mut config =
        webp::WebPConfig::new().map_err(|_| Error::Encode("WebPConfig 初始化失败".into()))?;
    config.quality = 80.0;
    config.use_sharp_yuv = 1;
    let out = encoder
        .encode_advanced(&config)
        .map_err(|e| Error::Encode(format!("WebP 编码失败：{e:?}")))?;
    Ok(out.to_vec())
}

/// 从 WebP 头部读尺寸（不解码像素），用于缓存命中时回填宽高。
pub fn webp_dims(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 30 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return None;
    }
    match &bytes[12..16] {
        b"VP8X" => {
            let w = 1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]);
            let h = 1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]);
            Some((w, h))
        }
        b"VP8L" => {
            let b = [bytes[21], bytes[22], bytes[23], bytes[24]];
            let bits = u32::from_le_bytes(b);
            let w = 1 + (bits & 0x3FFF);
            let h = 1 + ((bits >> 14) & 0x3FFF);
            Some((w, h))
        }
        b"VP8 " => {
            let w = 1 + (u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3FFF) as u32;
            let h = 1 + (u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3FFF) as u32;
            Some((w, h))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn q80_roundtrip_has_expected_dims() {
        let rgba = vec![128u8; 4 * 40 * 30];
        let webp = encode_q80(&rgba, 40, 30).unwrap();
        assert_eq!(webp_dims(&webp), Some((40, 30)));
    }

    #[test]
    fn lossless_is_small_for_flat_color() {
        let rgba = vec![200u8; 4 * 32 * 32];
        let webp = encode_lossless(&rgba, 32, 32).unwrap();
        assert!(webp.len() < 1024, "L0 体积 {} 应 < 1KB", webp.len());
        assert_eq!(webp_dims(&webp), Some((32, 32)));
    }
}
