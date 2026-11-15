//! 魔数探测：只看字节，不看扩展名（`01-方案文档.md` §1.2）。

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Jpeg,
    Png,
    Tiff,
    Bmp,
    WebP,
    Gif,
    Heic,
    Avif,
    Raw,
}

/// 探测格式需要的最大字节数（ISO BMFF 的 `ftyp` 品牌在 4..12）。
const HEAD: usize = 32;

pub fn probe_bytes(bytes: &[u8]) -> Option<ImageFormat> {
    let b = if bytes.len() > HEAD {
        &bytes[..HEAD]
    } else {
        bytes
    };

    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(ImageFormat::Jpeg);
    }
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(ImageFormat::Png);
    }
    if b.starts_with(b"II\x2A\x00") || b.starts_with(b"MM\x00\x2A") {
        return Some(ImageFormat::Tiff);
    }
    if b.starts_with(b"BM") {
        return Some(ImageFormat::Bmp);
    }
    if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        return Some(ImageFormat::Gif);
    }
    if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return Some(ImageFormat::WebP);
    }
    if b.len() >= 12 && &b[4..8] == b"ftyp" {
        let brand = &b[8..12];
        return match brand {
            b"heic" | b"heix" | b"hevc" | b"hevx" | b"heim" | b"heis" | b"hevm" | b"hevs"
            | b"mif1" | b"msf1" => Some(ImageFormat::Heic),
            b"avif" | b"avis" => Some(ImageFormat::Avif),
            b"crx " => Some(ImageFormat::Raw),
            _ => None,
        };
    }
    None
}

pub fn probe_file(path: &std::path::Path) -> crate::Result<ImageFormat> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut head = [0u8; HEAD];
    let n = f.read(&mut head)?;
    probe_bytes(&head[..n]).ok_or_else(|| crate::Error::UnknownFormat(path.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_by_magic_not_extension() {
        assert_eq!(
            probe_bytes(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some(ImageFormat::Jpeg)
        );
        assert_eq!(
            probe_bytes(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0]),
            Some(ImageFormat::Png)
        );
        let mut heic = vec![0u8; 24];
        heic[4..8].copy_from_slice(b"ftyp");
        heic[8..12].copy_from_slice(b"heic");
        assert_eq!(probe_bytes(&heic), Some(ImageFormat::Heic));
        let mut avif = vec![0u8; 24];
        avif[4..8].copy_from_slice(b"ftyp");
        avif[8..12].copy_from_slice(b"avif");
        assert_eq!(probe_bytes(&avif), Some(ImageFormat::Avif));
        assert_eq!(probe_bytes(b"not an image at all"), None);
    }
}
