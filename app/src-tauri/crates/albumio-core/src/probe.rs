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

/// RAW 家族的扩展名。TIFF 系 RAW（CR2/NEF/ARW/DNG/ORF/RW2…）与普通 TIFF
/// 共用同一个魔数，只靠字节分不开，只能再拿扩展名收窄；CR3 的 `crx ` 品牌
/// 则能直接由魔数判定。
pub(crate) const RAW_EXTS: &[&str] = &[
    "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "rw2", "raw", "orf",
    "pef", "rwl", "srw", "x3f", "3fr", "fff", "iiq", "mos", "mrw", "kdc", "mef", "erf",
];

pub fn is_raw_ext(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| RAW_EXTS.iter().any(|x| x.eq_ignore_ascii_case(e)))
        .unwrap_or(false)
}

/// 用扩展名细化魔数结果：TIFF 魔数 + RAW 扩展名才算 Raw，否则 `.tif/.tiff`
/// 会被误判成 RAW。反过来，扩展名是 RAW 但魔数不是 TIFF（如 CR3）时以魔数为准，
/// 不做任何覆盖。
fn refine(path: &std::path::Path, format: ImageFormat) -> ImageFormat {
    if format == ImageFormat::Tiff && is_raw_ext(path) {
        ImageFormat::Raw
    } else {
        format
    }
}

pub fn probe_file(path: &std::path::Path) -> crate::Result<ImageFormat> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut head = [0u8; HEAD];
    let n = f.read(&mut head)?;
    let format = probe_bytes(&head[..n])
        .ok_or_else(|| crate::Error::UnknownFormat(path.display().to_string()))?;
    Ok(refine(path, format))
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

    /// TIFF 系 RAW 与普通 TIFF 魔数相同，只能靠扩展名区分；
    /// 反过来 `.tif` 不能被 RAW 扩展名规则误伤。
    #[test]
    fn tiff_raw_is_separated_by_extension() {
        let dir = tempfile::tempdir().unwrap();
        let magic = b"II\x2A\x00\x08\x00\x00\x00";
        for (name, expect) in [
            ("IMG_0001.CR2", ImageFormat::Raw),
            ("DSC_0007.NEF", ImageFormat::Raw),
            ("P1000123.ARW", ImageFormat::Raw),
            ("scan.tif", ImageFormat::Tiff),
            ("scan.TIFF", ImageFormat::Tiff),
        ] {
            let path = dir.path().join(name);
            std::fs::write(&path, magic).unwrap();
            assert_eq!(probe_file(&path).unwrap(), expect, "{name}");
        }
    }

    #[test]
    fn cr3_brand_is_detected_as_raw_by_magic() {
        let mut cr3 = vec![0u8; 24];
        cr3[4..8].copy_from_slice(b"ftyp");
        cr3[8..12].copy_from_slice(b"crx ");
        assert_eq!(probe_bytes(&cr3), Some(ImageFormat::Raw));
    }
}
