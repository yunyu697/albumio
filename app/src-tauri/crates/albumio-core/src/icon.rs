//! 程序图标的位图解码。
//!
//! 图标源是矢量 SVG（`design/assets/app-icon/`），各平台格式由 `tauri icon` 生成；
//! Windows 运行时切换窗口图标时，Tauri 只接受 RGBA 原始像素，这里负责把 PNG 解出来。

/// PNG →（RGBA 像素, 宽, 高）。
pub fn decode_png_rgba(bytes: &[u8]) -> crate::Result<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map_err(|e| crate::Error::Decode(e.to_string()))?
        .to_rgba8();
    let (w, h) = (img.width(), img.height());
    Ok((img.into_raw(), w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_png_to_rgba() {
        // 1×1 透明 PNG
        let png: &[u8] = &[
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let (rgba, w, h) = decode_png_rgba(png).unwrap();
        assert_eq!((w, h), (1, 1));
        assert_eq!(rgba.len(), 4);
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        assert!(decode_png_rgba(b"not a png").is_err());
    }
}
