//! 元数据：EXIF / XMP 抽取、MWG 合并、拍摄时间回退、ICC 名称、直方图（04-项目计划 M4）。
//!
//! 三条硬规则（`02-设计规范.md` §11.3）：
//! 1. EXIF 与 XMP 冲突时以 XMP 为准（MWG 合并），合并结果必须带来源；
//! 2. 没有拍摄时间就回退文件 mtime，并标「推断」，不允许显示成 EXIF 时间；
//! 3. 直方图按 sRGB 转换后的像素统计，裁切区域外仍计入（M4 尚无裁切，天然满足）。
//!
//! 元数据缺失、损坏都是正常情况：这里只返回"有没有"，不把图片判为不可读。

use crate::{Error, Result};
use serde::Serialize;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

/// 直方图分箱数（`02-设计规范.md` §11.3：无坐标轴，视觉效果优先）。
pub const HIST_BINS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MetaSource {
    Exif,
    Xmp,
    Inferred,
}

#[derive(Debug, Clone, Default)]
pub struct ExifMeta {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub taken_at: Option<i64>,
    pub exposure: Option<String>,
    pub f_number: Option<f64>,
    pub iso: Option<u32>,
    pub focal: Option<f64>,
    pub orientation: Option<u8>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub gps: Option<(f64, f64)>,
    pub description: Option<String>,
    pub artist: Option<String>,
    pub copyright: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct XmpMeta {
    pub title: Option<String>,
    pub creator: Option<String>,
    pub keywords: Vec<String>,
    pub rights: Option<String>,
    pub rating: Option<u8>,
    pub create_date: Option<i64>,
}

/// MWG 合并结果。每一项都带来源，前端只展示"用户可能要追问来源"的字段。
#[derive(Debug, Clone, Default)]
pub struct Merged {
    pub taken_at: i64,
    pub taken_at_text: Option<String>,
    pub taken_source: Option<MetaSource>,
    pub title: Option<String>,
    pub title_source: Option<MetaSource>,
    pub keywords: Vec<String>,
    pub keywords_source: Option<MetaSource>,
    pub rights: Option<String>,
    pub rights_source: Option<MetaSource>,
    pub rating: Option<u8>,
    pub rating_source: Option<MetaSource>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gps {
    pub lat: f64,
    pub lon: f64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Histogram {
    pub bins: usize,
    pub r: Vec<u32>,
    pub g: Vec<u32>,
    pub b: Vec<u32>,
    pub pixels: u64,
}

/// 检查器一次拿到的全部内容。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoMeta {
    pub path: String,
    pub name: String,
    pub format: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub size: u64,
    pub mtime_ns: i128,
    pub taken_at: i64,
    /// 只有 EXIF/XMP 给的时间才有文本；「推断」交给前端按本地时区格式化 mtime。
    pub taken_at_text: Option<String>,
    pub taken_source: Option<MetaSource>,
    pub title: Option<String>,
    pub title_source: Option<MetaSource>,
    pub keywords: Vec<String>,
    pub keywords_source: Option<MetaSource>,
    pub rights: Option<String>,
    pub rights_source: Option<MetaSource>,
    pub rating: Option<u8>,
    pub rating_source: Option<MetaSource>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub exposure: Option<String>,
    pub iso: Option<u32>,
    pub focal: Option<f64>,
    pub orientation: u8,
    pub orientation_source: Option<MetaSource>,
    pub gps: Option<Gps>,
    pub icc: Option<String>,
    pub histogram: Histogram,
}

/// 读取一张图的元数据。EXIF/XMP 缺失都不算错误；只有文件本身不可读才返回 Err。
pub fn read(path: &Path) -> Result<PhotoMeta> {
    let fs_meta = std::fs::metadata(path)?;
    let mtime_ns = crate::cache::mtime_ns(&fs_meta);
    let mtime_ms = div_floor(mtime_ns, 1_000_000);

    let mut head = [0u8; 32];
    let head_n = {
        let mut f = File::open(path)?;
        f.read(&mut head)?
    };
    let format = crate::probe::probe_bytes(&head[..head_n])
        .map(|f| format!("{f:?}").to_lowercase())
        .unwrap_or_else(|| "unknown".into());

    let exif = read_exif(path);
    let xmp = xmp_packet_from_file(path)
        .map(|packet| parse_xmp(&String::from_utf8_lossy(&packet)))
        .unwrap_or_default();
    let merged = merge(&exif, &xmp, mtime_ms);

    let dims = image::ImageReader::open(path)
        .ok()
        .and_then(|r| r.with_guessed_format().ok())
        .and_then(|r| r.into_dimensions().ok());
    let width = dims.map(|d| d.0).or(exif.width);
    let height = dims.map(|d| d.1).or(exif.height);

    let icc = {
        let raw = read_head(path, 1 << 20);
        raw.and_then(|bytes| {
            crate::decode::read_icc(&bytes, crate::probe::probe_bytes(&bytes)?)
                .and_then(|p| icc_name(&p))
        })
    };

    Ok(PhotoMeta {
        path: path.display().to_string(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        format,
        width,
        height,
        size: fs_meta.len(),
        mtime_ns,
        taken_at: merged.taken_at,
        taken_at_text: merged.taken_at_text,
        taken_source: merged.taken_source,
        title: merged.title,
        title_source: merged.title_source,
        keywords: merged.keywords,
        keywords_source: merged.keywords_source,
        rights: merged.rights,
        rights_source: merged.rights_source,
        rating: merged.rating,
        rating_source: merged.rating_source,
        camera: camera_name(&exif),
        lens: exif.lens.clone(),
        exposure: exposure_text(&exif),
        iso: exif.iso,
        focal: exif.focal,
        orientation: exif.orientation.unwrap_or(1),
        orientation_source: exif.orientation.map(|_| MetaSource::Exif),
        gps: exif.gps.map(|(lat, lon)| Gps { lat, lon }),
        icc,
        histogram: Histogram::default(),
    })
}

/// 时间线只需要的三个值：拍摄时间、可读文本、来源（EXIF/XMP/推断）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Taken {
    pub taken_at: i64,
    pub taken_at_text: Option<String>,
    pub source: MetaSource,
}

/// 比 [`read`] 轻得多：只读 EXIF 的拍摄时间与 XMP 的 createDate，不解尺寸、不取 ICC、不算直方图。
/// 时间线要按拍摄时间分桶，1 万项时不能走完整元数据读取。
pub fn taken_of(path: &Path) -> Result<Taken> {
    let fs_meta = std::fs::metadata(path)?;
    let mtime_ms = div_floor(crate::cache::mtime_ns(&fs_meta), 1_000_000);
    let exif = read_exif(path);
    let xmp = xmp_packet_from_file(path)
        .map(|packet| parse_xmp(&String::from_utf8_lossy(&packet)))
        .unwrap_or_default();
    let merged = merge(&exif, &xmp, mtime_ms);
    Ok(Taken {
        taken_at: merged.taken_at,
        taken_at_text: merged.taken_at_text,
        source: merged.taken_source.unwrap_or(MetaSource::Inferred),
    })
}

/// MWG 合并：XMP 优先，EXIF 兜底，最后回退文件时间并标「推断」。
pub fn merge(exif: &ExifMeta, xmp: &XmpMeta, mtime_ms: i64) -> Merged {
    let (taken_at, taken_at_text, taken_source) = if let Some(t) = xmp.create_date {
        (t, Some(format_text(t)), Some(MetaSource::Xmp))
    } else if let Some(t) = exif.taken_at {
        (t, Some(format_text(t)), Some(MetaSource::Exif))
    } else {
        (mtime_ms, None, Some(MetaSource::Inferred))
    };

    let (title, title_source) = pick(
        xmp.title.clone().map(|v| (v, MetaSource::Xmp)),
        exif.description.clone().map(|v| (v, MetaSource::Exif)),
    );
    let (rights, rights_source) = pick(
        xmp.rights.clone().map(|v| (v, MetaSource::Xmp)),
        exif.copyright.clone().map(|v| (v, MetaSource::Exif)),
    );
    let keywords_source = if xmp.keywords.is_empty() {
        None
    } else {
        Some(MetaSource::Xmp)
    };
    // 评级只有 XMP 一个来源：EXIF 没有标准 Rating 标签，
    // 强行从厂商私有标签猜会让"评级来源"这枚胶囊变成假信息。
    let (rating, rating_source) = match xmp.rating {
        Some(r) => (Some(r), Some(MetaSource::Xmp)),
        None => (None, None),
    };

    Merged {
        taken_at,
        taken_at_text,
        taken_source,
        title,
        title_source,
        keywords: xmp.keywords.clone(),
        keywords_source,
        rights,
        rights_source,
        rating,
        rating_source,
    }
}

fn pick(
    primary: Option<(String, MetaSource)>,
    fallback: Option<(String, MetaSource)>,
) -> (Option<String>, Option<MetaSource>) {
    match primary.or(fallback) {
        Some((v, s)) if !v.trim().is_empty() => (Some(v), Some(s)),
        _ => (None, None),
    }
}

fn camera_name(exif: &ExifMeta) -> Option<String> {
    match (&exif.make, &exif.model) {
        (Some(make), Some(model)) => {
            if model.to_lowercase().starts_with(&make.to_lowercase()) {
                Some(model.clone())
            } else {
                Some(format!("{make} {model}"))
            }
        }
        (None, Some(model)) => Some(model.clone()),
        (Some(make), None) => Some(make.clone()),
        _ => None,
    }
}

fn exposure_text(exif: &ExifMeta) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(e) = &exif.exposure {
        parts.push(e.clone());
    }
    if let Some(f) = exif.f_number {
        parts.push(format!("f/{f:.1}"));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    }
}

/* ---------------- EXIF ---------------- */

fn read_exif(path: &Path) -> ExifMeta {
    let mut out = ExifMeta::default();
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return out,
    };
    let exif = match exif::Reader::new().read_from_container(&mut BufReader::new(file)) {
        Ok(e) => e,
        Err(_) => return out,
    };
    let get = |tag: exif::Tag| text_of(&exif, tag);
    let uint = |tag: exif::Tag| {
        exif.get_field(tag, exif::In::PRIMARY)
            .and_then(|f| f.value.get_uint(0))
    };

    out.make = get(exif::Tag::Make);
    out.model = get(exif::Tag::Model);
    out.lens = get(exif::Tag::LensModel);
    out.description = get(exif::Tag::ImageDescription);
    out.artist = get(exif::Tag::Artist);
    out.copyright = get(exif::Tag::Copyright);
    out.taken_at = get(exif::Tag::DateTimeOriginal).and_then(|s| parse_datetime(&s));
    out.iso = uint(exif::Tag::PhotographicSensitivity);
    out.orientation = uint(exif::Tag::Orientation)
        .map(|v| v as u8)
        .filter(|v| (1..=8).contains(v));
    out.width = uint(exif::Tag::PixelXDimension);
    out.height = uint(exif::Tag::PixelYDimension);
    out.f_number = rational_of(&exif, exif::Tag::FNumber);
    out.focal = rational_of(&exif, exif::Tag::FocalLength);
    out.exposure = exif
        .get_field(exif::Tag::ExposureTime, exif::In::PRIMARY)
        .and_then(|f| match &f.value {
            exif::Value::Rational(v) => v.first().map(|r| {
                if r.num != 0 && r.denom > r.num {
                    format!("1/{}s", (r.denom as f64 / r.num as f64).round() as u32)
                } else {
                    format!("{:.1}s", r.to_f32())
                }
            }),
            _ => None,
        });
    out.gps = gps_of(&exif);
    out
}

fn text_of(exif: &exif::Exif, tag: exif::Tag) -> Option<String> {
    let f = exif.get_field(tag, exif::In::PRIMARY)?;
    let s = f.display_value().to_string();
    let s = s.trim().trim_matches('\0').trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn rational_of(exif: &exif::Exif, tag: exif::Tag) -> Option<f64> {
    let f = exif.get_field(tag, exif::In::PRIMARY)?;
    match &f.value {
        exif::Value::Rational(v) => v.first().map(|r| r.to_f64()).filter(|v| v.is_finite()),
        _ => None,
    }
}

fn gps_of(exif: &exif::Exif) -> Option<(f64, f64)> {
    let coord = |value_tag: exif::Tag, ref_tag: exif::Tag| -> Option<f64> {
        // GPS IFD 由主 IFD 的 GPSInfo 指针挂进来，reader 统一按 PRIMARY 暴露。
        let f = exif.get_field(value_tag, exif::In::PRIMARY)?;
        let parts = match &f.value {
            exif::Value::Rational(v) if v.len() >= 3 => {
                v[0].to_f64() + v[1].to_f64() / 60.0 + v[2].to_f64() / 3600.0
            }
            _ => return None,
        };
        let r = exif
            .get_field(ref_tag, exif::In::PRIMARY)?
            .display_value()
            .to_string();
        let negative = r.trim().starts_with(['S', 'W']);
        Some(if negative { -parts } else { parts })
    };
    let lat = coord(exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef)?;
    let lon = coord(exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef)?;
    Some((lat, lon))
}

/* ---------------- XMP ---------------- */

/// 只读文件头部 1MB 找 XMP：XMP 包在 JPEG/PNG/WebP 里都紧跟头部，
/// 没必要为元数据把 40MB 原图整个读进来。
fn xmp_packet_from_file(path: &Path) -> Option<Vec<u8>> {
    let bytes = read_head(path, 1 << 20)?;
    xmp_packet(&bytes).map(|p| p.to_vec())
}

fn read_head(path: &Path, limit: usize) -> Option<Vec<u8>> {
    let mut f = File::open(path).ok()?;
    let mut buf = Vec::with_capacity(limit.min(1 << 16));
    let mut chunk = [0u8; 8192];
    while buf.len() < limit {
        let n = f.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Some(buf)
}

pub fn xmp_packet(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.starts_with(&[0xFF, 0xD8]) {
        jpeg_xmp(bytes)
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        png_xmp(bytes)
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        webp_xmp(bytes)
    } else {
        None
    }
}

fn jpeg_xmp(bytes: &[u8]) -> Option<&[u8]> {
    const SIG: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
    let mut i = 2usize;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            return None;
        }
        let marker = bytes[i + 1];
        if marker == 0xDA {
            return None; // 进入扫描数据，后面不会再有 XMP
        }
        if marker == 0x01 || (0xD0..=0xD9).contains(&marker) {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if len < 2 || i + 2 + len > bytes.len() {
            return None;
        }
        let body = &bytes[i + 4..i + 2 + len];
        if marker == 0xE1 && body.starts_with(SIG) {
            return Some(&body[SIG.len()..]);
        }
        i += 2 + len;
    }
    None
}

fn png_xmp(bytes: &[u8]) -> Option<&[u8]> {
    let mut i = 8usize;
    while i + 8 <= bytes.len() {
        let len = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]) as usize;
        let ty = &bytes[i + 4..i + 8];
        let body_end = (i + 8 + len).min(bytes.len());
        let body = &bytes[i + 8..body_end];
        if ty == b"iTXt" {
            if let Some(nul) = body.iter().position(|&b| b == 0) {
                if &body[..nul] == b"XML:com.adobe.xmp" {
                    let rest = &body[nul + 1..];
                    // compression flag(1) + method(1) + language\0 + translated\0 + text
                    if rest.len() > 2 && rest[0] == 0 {
                        let lang = rest[2..].iter().position(|&b| b == 0)?;
                        let after_lang = &rest[2 + lang + 1..];
                        let trans = after_lang.iter().position(|&b| b == 0)?;
                        return Some(&after_lang[trans + 1..]);
                    }
                }
            }
        }
        i += 12 + len;
    }
    None
}

fn webp_xmp(bytes: &[u8]) -> Option<&[u8]> {
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
        if id == b"XMP " {
            return Some(&bytes[body..body + len]);
        }
        pos = body + len + (len & 1);
    }
    None
}

pub fn parse_xmp(xml: &str) -> XmpMeta {
    use quick_xml::events::Event;

    let mut xmp = XmpMeta::default();
    let mut reader = quick_xml::Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut stack: Vec<String> = Vec::new();
    let mut li: Option<String> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = local_name(e.local_name().as_ref());
                if name == "li" {
                    li = Some(String::new());
                }
                apply_attrs(&mut xmp, &e);
                stack.push(name);
            }
            Ok(Event::Empty(e)) => {
                apply_attrs(&mut xmp, &e);
            }
            Ok(Event::Text(t)) => {
                if let Ok(s) = t.unescape() {
                    if let Some(buf) = li.as_mut() {
                        buf.push_str(&s);
                    } else if let Some(name) = stack.last() {
                        apply_kv(&mut xmp, name, &s);
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = local_name(e.local_name().as_ref());
                if name == "li" {
                    // 集合项（dc:title / dc:subject / dc:rights …）挂在最近的集合元素上
                    if let Some(text) = li.take() {
                        if let Some(owner) = stack
                            .iter()
                            .rev()
                            .skip(1)
                            .find(|n| is_collection(n))
                            .cloned()
                        {
                            apply_kv(&mut xmp, &owner, &text);
                        }
                    }
                }
                stack.pop();
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    xmp
}

fn apply_attrs(xmp: &mut XmpMeta, e: &quick_xml::events::BytesStart<'_>) {
    for attr in e.attributes().flatten() {
        let key = local_name(attr.key.local_name().as_ref());
        if let Ok(v) = attr.unescape_value() {
            apply_kv(xmp, &key, &v);
        }
    }
}

fn is_collection(name: &str) -> bool {
    matches!(name, "title" | "subject" | "creator" | "rights")
}

fn apply_kv(xmp: &mut XmpMeta, name: &str, raw: &str) {
    let v = raw.trim();
    if v.is_empty() {
        return;
    }
    match name {
        "title" => {
            if xmp.title.is_none() {
                xmp.title = Some(v.to_string());
            }
        }
        "subject" => {
            if !xmp.keywords.iter().any(|k| k == v) {
                xmp.keywords.push(v.to_string());
            }
        }
        "creator" => {
            if xmp.creator.is_none() {
                xmp.creator = Some(v.to_string());
            }
        }
        "rights" => {
            if xmp.rights.is_none() {
                xmp.rights = Some(v.to_string());
            }
        }
        "rating" => {
            if let Ok(n) = v.parse::<i32>() {
                if (0..=5).contains(&n) {
                    xmp.rating = Some(n as u8);
                }
            }
        }
        // MWG：xmp:CreateDate 是拍摄时间的权威来源；Photoshop 的 DateCreated 同义。
        "createdate" | "datecreated" => {
            if xmp.create_date.is_none() {
                xmp.create_date = parse_datetime(v);
            }
        }
        _ => {}
    }
}

fn local_name(raw: &[u8]) -> String {
    let s = String::from_utf8_lossy(raw);
    let local = s.rsplit(':').next().unwrap_or(&s);
    local.to_ascii_lowercase()
}

/* ---------------- 时间 ---------------- */

/// 解析 EXIF 的 `2024:11:03 16:20:00` 与 XMP 的 `2024-11-03T16:20:00+09:00`。
/// 时区偏移忽略：文件里记的是"拍摄地的墙上时间"，展示就按这串数字展示。
pub fn parse_datetime(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, time) = s.split_once(['T', ' ']).unwrap_or((s, "00:00:00"));
    let mut d = date.split([':', '-', '/']);
    let y: i64 = d.next()?.parse().ok()?;
    let mo: u32 = d.next()?.parse().ok()?;
    let da: u32 = d.next()?.parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&da) {
        return None;
    }
    let mut t = time.split(':');
    let h: i64 = num_prefix(t.next()?)?;
    let mi: i64 = t.next().map(num_prefix).unwrap_or(Some(0))?;
    // 秒后面可能带时区（`00+09:00` / `00Z`）：只取数字前缀。
    let se: i64 = t.next().map(num_prefix).unwrap_or(Some(0))?;
    if !(0..24).contains(&h) || !(0..60).contains(&mi) || !(0..61).contains(&se) {
        return None;
    }
    let days = days_from_civil(y, mo, da);
    Some(days * 86_400_000 + (h * 3600 + mi * 60 + se) * 1000)
}

/// 只取开头的 ASCII 数字（`16` / `00+09` → `0` 的后半段留给时区）。
fn num_prefix(s: &str) -> Option<i64> {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
}

/// Howard Hinnant 的 civil→days 算法（不引 chrono，只需这一处换算）。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = ((m + 9) % 12) as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn div_floor(a: i128, b: i128) -> i64 {
    let q = a.div_euclid(b);
    q as i64
}

/// 只用于元数据里的拍摄时间（墙上时间），不参与本地时区换算。
fn format_text(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let sec = rem / 1000;
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}",
        sec / 3600,
        (sec % 3600) / 60
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/* ---------------- ICC / 直方图 ---------------- */

/// ICC 描述名（`02-设计规范.md` §11.3 的"色彩配置"一行）。解析失败就不显示，不报错。
pub fn icc_name(icc: &[u8]) -> Option<String> {
    let profile = lcms2::Profile::new_icc(icc).ok()?;
    let desc = profile.info(lcms2::InfoType::Description, lcms2::Locale::none())?;
    let desc = desc.trim().to_string();
    if desc.is_empty() {
        None
    } else {
        Some(desc)
    }
}

impl Histogram {
    pub fn from_rgba(rgba: &[u8], bins: usize) -> Self {
        let bins = bins.max(1);
        let mut r = vec![0u32; bins];
        let mut g = vec![0u32; bins];
        let mut b = vec![0u32; bins];
        let mut pixels = 0u64;
        for px in rgba.chunks_exact(4) {
            let idx = |v: u8| (v as usize * bins) / 256;
            r[idx(px[0])] += 1;
            g[idx(px[1])] += 1;
            b[idx(px[2])] += 1;
            pixels += 1;
        }
        Histogram {
            bins,
            r,
            g,
            b,
            pixels,
        }
    }
}

/// 从管线产出的 L1 WebP 统计直方图：像素已在管线里转过 sRGB，满足 §11.3 口径。
pub fn histogram_webp(bytes: &[u8]) -> Result<Histogram> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::WebP)
        .map_err(|e| Error::Decode(format!("直方图解码失败：{e}")))?;
    Ok(Histogram::from_rgba(&img.to_rgba8(), HIST_BINS))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exif_with_time() -> ExifMeta {
        ExifMeta {
            make: Some("SONY".into()),
            model: Some("ILCE-7M4".into()),
            taken_at: Some(parse_datetime("2024:11:03 16:20:00").unwrap()),
            ..Default::default()
        }
    }

    #[test]
    fn xmp_wins_over_exif_on_conflict() {
        let exif = ExifMeta {
            taken_at: Some(parse_datetime("2020:01:01 00:00:00").unwrap()),
            copyright: Some("EXIF 版权".into()),
            ..exif_with_time()
        };
        let xmp = XmpMeta {
            rights: Some("XMP 版权".into()),
            rating: Some(5),
            create_date: Some(parse_datetime("2024-11-03T16:20:00").unwrap()),
            keywords: vec!["旅行".into(), "京都".into()],
            ..Default::default()
        };
        let m = merge(&exif, &xmp, 1_700_000_000_000);
        assert_eq!(m.rating, Some(5), "评级必须以 XMP 为准");
        assert_eq!(m.rating_source, Some(MetaSource::Xmp));
        assert_eq!(m.rights.as_deref(), Some("XMP 版权"));
        assert_eq!(m.rights_source, Some(MetaSource::Xmp));
        assert_eq!(m.taken_source, Some(MetaSource::Xmp));
        assert_eq!(m.taken_at_text.as_deref(), Some("2024-11-03 16:20"));
        assert_eq!(m.keywords, vec!["旅行", "京都"]);
    }

    #[test]
    fn missing_xmp_falls_back_to_exif() {
        let exif = ExifMeta {
            copyright: Some("EXIF 版权".into()),
            description: Some("EXIF 标题".into()),
            ..exif_with_time()
        };
        let m = merge(&exif, &XmpMeta::default(), 1_700_000_000_000);
        assert_eq!(m.rating, None);
        assert_eq!(m.rating_source, None);
        assert_eq!(m.title.as_deref(), Some("EXIF 标题"));
        assert_eq!(m.title_source, Some(MetaSource::Exif));
        assert_eq!(m.taken_source, Some(MetaSource::Exif));
        assert!(m.keywords.is_empty());
        assert_eq!(m.keywords_source, None);
    }

    #[test]
    fn missing_both_infers_mtime_without_inventing_text() {
        let mtime = parse_datetime("2019-05-06T07:08:09").unwrap();
        let m = merge(&ExifMeta::default(), &XmpMeta::default(), mtime);
        assert_eq!(m.taken_at, mtime);
        assert_eq!(m.taken_source, Some(MetaSource::Inferred));
        assert_eq!(m.taken_at_text, None, "推断时间不能伪装成 EXIF 文本");
        assert_eq!(m.rating_source, None);
    }

    #[test]
    fn xmp_packet_parses_lang_alt_and_attributes() {
        let xml = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="4">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">京都夜行</rdf:li></rdf:Alt></dc:title>
<dc:subject><rdf:Bag><rdf:li>旅行</rdf:li><rdf:li>夜景</rdf:li></rdf:Bag></dc:subject>
<dc:rights><rdf:Alt><rdf:li xml:lang="x-default">© 2024 Tyler Zhang</rdf:li></rdf:Alt></dc:rights>
<xmp:CreateDate>2024-11-03T16:20:00+09:00</xmp:CreateDate>
</rdf:Description></rdf:RDF></x:xmpmeta>"#;
        let x = parse_xmp(xml);
        assert_eq!(x.title.as_deref(), Some("京都夜行"));
        assert_eq!(x.keywords, vec!["旅行", "夜景"]);
        assert_eq!(x.rights.as_deref(), Some("© 2024 Tyler Zhang"));
        assert_eq!(x.rating, Some(4));
        assert_eq!(
            x.create_date,
            Some(parse_datetime("2024-11-03T16:20:00").unwrap())
        );
    }

    #[test]
    fn jpeg_app1_xmp_packet_is_located() {
        let xmp = b"<x:xmpmeta/>";
        let mut seg = Vec::new();
        seg.extend_from_slice(b"http://ns.adobe.com/xap/1.0/\0");
        seg.extend_from_slice(xmp);
        let mut jpg = vec![0xFF, 0xD8];
        jpg.extend_from_slice(&[0xFF, 0xE1]);
        jpg.extend_from_slice(&((seg.len() + 2) as u16).to_be_bytes());
        jpg.extend_from_slice(&seg);
        jpg.extend_from_slice(&[0xFF, 0xD9]);
        assert_eq!(xmp_packet(&jpg), Some(&xmp[..]));
    }

    #[test]
    fn dates_round_trip() {
        let ms = parse_datetime("2024:11:03 16:20:00").unwrap();
        assert_eq!(format_text(ms), "2024-11-03 16:20");
        assert_eq!(parse_datetime("2024-11-03 16:20"), Some(ms));
        assert_eq!(parse_datetime("not a date"), None);
        assert_eq!(parse_datetime("2024-13-03 16:20:00"), None);
    }

    #[test]
    fn histogram_counts_every_pixel_per_channel() {
        // 4 个像素，R 通道全 0 → 只有第 0 箱；G 128 → 第 32 箱（64 箱）；B 255 → 第 63 箱。
        let rgba = [
            0, 128, 255, 255, 0, 128, 255, 255, 0, 128, 255, 255, 0, 128, 255, 255,
        ];
        let h = Histogram::from_rgba(&rgba, 64);
        assert_eq!(h.pixels, 4);
        assert_eq!(h.r[0], 4);
        assert_eq!(h.g[32], 4);
        assert_eq!(h.b[63], 4);
        assert_eq!(h.r.iter().sum::<u32>(), 4);
    }

    #[test]
    fn negative_mtime_is_floored_not_truncated() {
        // Windows 上早于 1970 的文件 mtime 是负数：向下取整才能得到正确的毫秒时刻。
        assert_eq!(div_floor(-1, 1_000_000), -1);
        assert_eq!(div_floor(-1_000_001, 1_000_000), -2);
        assert_eq!(div_floor(1_999_999, 1_000_000), 1);
    }
}
