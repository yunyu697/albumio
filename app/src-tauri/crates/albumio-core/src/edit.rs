//! 非破坏性编辑（04-项目计划 M6；`01-方案文档.md` §5）。
//!
//! 编辑栈是唯一真相：原图只读，预览与导出都走同一段 [`apply_ops`]，只差输入位图
//! 的尺寸（预览用 2048 代理，导出用原图）。三条硬规则：
//!
//! 1. 顺序固定 `orient → crop → 色彩 → 锐化`，无论 JSON 里怎么排都按此执行；
//! 2. 裁剪存 0–1 归一化坐标，换分辨率不漂移；
//! 3. 同一操作只有一条，重复项以后出现的为准（滑杆只改值，不追加行）。

use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const STACK_VERSION: u32 = 1;
/// 集中式 sidecar 目录（不散落 `.xmp` 到照片旁边，`01-方案文档.md` §5.3）。
pub const SIDECAR_DIR: &str = ".albumio";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EditStack {
    pub v: u32,
    #[serde(default)]
    pub ops: Vec<Op>,
}

impl Default for EditStack {
    fn default() -> Self {
        Self {
            v: STACK_VERSION,
            ops: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Op {
    /// 旋转（90 的倍数，顺时针）与水平翻转；先翻转再旋转。
    Orient {
        #[serde(default)]
        deg: i32,
        #[serde(default)]
        flip: bool,
    },
    /// 裁剪：orientation 之后的归一化矩形 `[x, y, w, h]`。
    Crop {
        rect: [f64; 4],
        #[serde(default)]
        aspect: Option<String>,
    },
    Exposure {
        ev: f64,
    },
    Contrast {
        k: f64,
    },
    Saturation {
        k: f64,
    },
    Sharpen {
        amount: f64,
    },
}

impl Op {
    fn rank(&self) -> u8 {
        match self {
            Op::Orient { .. } => 0,
            Op::Crop { .. } => 1,
            Op::Exposure { .. } | Op::Contrast { .. } | Op::Saturation { .. } => 2,
            Op::Sharpen { .. } => 3,
        }
    }

    /// 同一操作的身份：滑杆与操作栈都靠它替换而不是追加。
    fn key(&self) -> &'static str {
        match self {
            Op::Orient { .. } => "orient",
            Op::Crop { .. } => "crop",
            Op::Exposure { .. } => "exposure",
            Op::Contrast { .. } => "contrast",
            Op::Saturation { .. } => "saturation",
            Op::Sharpen { .. } => "sharpen",
        }
    }

    fn validate(&self) -> Result<()> {
        match self {
            Op::Orient { deg, .. } => {
                if deg % 90 != 0 {
                    return Err(Error::Invalid(format!("旋转角度必须是 90 的倍数：{deg}")));
                }
            }
            Op::Crop { rect, .. } => {
                let [x, y, w, h] = *rect;
                let inside = x >= 0.0
                    && y >= 0.0
                    && w > 0.0
                    && h > 0.0
                    && x + w <= 1.000_1
                    && y + h <= 1.000_1;
                if !inside {
                    return Err(Error::Invalid(format!("裁剪矩形越界：{rect:?}")));
                }
            }
            Op::Exposure { ev } => {
                if !(-5.0..=5.0).contains(ev) {
                    return Err(Error::Invalid(format!("曝光超出 ±5 EV：{ev}")));
                }
            }
            Op::Contrast { k } | Op::Saturation { k } => {
                if !(-1.0..=1.0).contains(k) {
                    return Err(Error::Invalid(format!("系数超出 -1..1：{k}")));
                }
            }
            Op::Sharpen { amount } => {
                if !(0.0..=2.0).contains(amount) {
                    return Err(Error::Invalid(format!("锐化量超出 0..2：{amount}")));
                }
            }
        }
        Ok(())
    }
}

impl EditStack {
    pub fn parse(json: &str) -> Result<Self> {
        if json.trim().is_empty() {
            return Ok(Self::default());
        }
        let mut stack: Self =
            serde_json::from_str(json).map_err(|e| Error::Invalid(format!("编辑栈 JSON：{e}")))?;
        if stack.v == 0 {
            stack.v = STACK_VERSION;
        }
        if stack.v > STACK_VERSION {
            return Err(Error::Invalid(format!(
                "编辑栈版本 {} 高于本程序支持的 {STACK_VERSION}",
                stack.v
            )));
        }
        stack.normalize()?;
        Ok(stack)
    }

    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string(self).map_err(|e| Error::Invalid(e.to_string()))
    }

    /// 排序 + 去重 + 校验。重复操作保留最后一条（滑杆拖动时前端会不断替换）。
    pub fn normalize(&mut self) -> Result<()> {
        let mut seen = std::collections::HashSet::new();
        let mut ops = Vec::with_capacity(self.ops.len());
        // 从后往前保留最后出现的同 key 项，再按固定顺序排。
        for op in self.ops.drain(..).rev() {
            if seen.insert(op.key()) {
                op.validate()?;
                ops.push(op);
            }
        }
        ops.reverse();
        ops.sort_by_key(|o| o.rank());
        self.ops = ops;
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }
}

pub struct Edited {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// 预览与导出共用的唯一实现（`01-方案文档.md` §5.2 规则 3）。
pub fn apply_ops(rgba: Vec<u8>, width: u32, height: u32, stack: &EditStack) -> Result<Edited> {
    let mut buf = rgba;
    let mut w = width;
    let mut h = height;
    for op in &stack.ops {
        match op {
            Op::Orient { deg, flip } => {
                if *flip {
                    buf = flip_horizontal(&buf, w, h);
                }
                let turns = (((deg % 360) + 360) % 360 / 90) as usize;
                for _ in 0..turns {
                    buf = rotate_cw(&buf, w, h);
                    std::mem::swap(&mut w, &mut h);
                }
            }
            Op::Crop { rect, .. } => {
                let (next, nw, nh) = crop(&buf, w, h, *rect);
                buf = next;
                w = nw;
                h = nh;
            }
            Op::Exposure { ev } => {
                let factor = 2f64.powf(*ev);
                for px in buf.chunks_exact_mut(4) {
                    for c in &mut px[..3] {
                        *c = clamp_u8(*c as f64 * factor);
                    }
                }
            }
            Op::Contrast { k } => {
                let factor = 1.0 + k;
                for px in buf.chunks_exact_mut(4) {
                    for c in &mut px[..3] {
                        *c = clamp_u8((*c as f64 - 127.5) * factor + 127.5);
                    }
                }
            }
            Op::Saturation { k } => {
                let factor = 1.0 + k;
                for px in buf.chunks_exact_mut(4) {
                    let gray =
                        0.2126 * px[0] as f64 + 0.7152 * px[1] as f64 + 0.0722 * px[2] as f64;
                    for c in &mut px[..3] {
                        *c = clamp_u8(gray + (*c as f64 - gray) * factor);
                    }
                }
            }
            Op::Sharpen { amount } => {
                buf = unsharp(&buf, w, h, *amount);
            }
        }
    }
    Ok(Edited {
        rgba: buf,
        width: w,
        height: h,
    })
}

fn clamp_u8(v: f64) -> u8 {
    v.round().clamp(0.0, 255.0) as u8
}

fn flip_horizontal(src: &[u8], w: u32, h: u32) -> Vec<u8> {
    let mut out = vec![0u8; src.len()];
    let row = w as usize * 4;
    for y in 0..h as usize {
        let s = &src[y * row..(y + 1) * row];
        let d = &mut out[y * row..(y + 1) * row];
        for x in 0..w as usize {
            let si = x * 4;
            let di = (w as usize - 1 - x) * 4;
            d[di..di + 4].copy_from_slice(&s[si..si + 4]);
        }
    }
    out
}

/// 顺时针 90°。`dst` 尺寸为 `(h, w)`。
fn rotate_cw(src: &[u8], w: u32, h: u32) -> Vec<u8> {
    let (wi, hi) = (w as usize, h as usize);
    let mut out = vec![0u8; src.len()];
    for dy in 0..wi {
        for dx in 0..hi {
            let sx = dy;
            let sy = hi - 1 - dx;
            let si = (sy * wi + sx) * 4;
            let di = (dy * hi + dx) * 4;
            out[di..di + 4].copy_from_slice(&src[si..si + 4]);
        }
    }
    out
}

fn crop(src: &[u8], w: u32, h: u32, rect: [f64; 4]) -> (Vec<u8>, u32, u32) {
    let [rx, ry, rw, rh] = rect;
    let x0 = ((rx * w as f64).round() as u32).min(w.saturating_sub(1));
    let y0 = ((ry * h as f64).round() as u32).min(h.saturating_sub(1));
    let x1 = (((rx + rw) * w as f64).round() as u32).clamp(x0 + 1, w);
    let y1 = (((ry + rh) * h as f64).round() as u32).clamp(y0 + 1, h);
    let (cw, ch) = (x1 - x0, y1 - y0);
    let mut out = Vec::with_capacity(cw as usize * ch as usize * 4);
    for y in y0..y1 {
        let start = ((y * w + x0) * 4) as usize;
        let end = start + cw as usize * 4;
        out.extend_from_slice(&src[start..end]);
    }
    (out, cw, ch)
}

/// 反锐化掩模：半径固定 1px（3×3 邻域均值），`amount` 0–2。
fn unsharp(src: &[u8], w: u32, h: u32, amount: f64) -> Vec<u8> {
    if amount <= 0.0 || w < 3 || h < 3 {
        return src.to_vec();
    }
    let (wi, hi) = (w as usize, h as usize);
    let mut out = src.to_vec();
    for y in 0..hi {
        for x in 0..wi {
            let i = (y * wi + x) * 4;
            for c in 0..3 {
                let mut sum = 0u32;
                let mut n = 0u32;
                for dy in -1i32..=1 {
                    for dx in -1i32..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let sx = (x as i32 + dx).clamp(0, wi as i32 - 1) as usize;
                        let sy = (y as i32 + dy).clamp(0, hi as i32 - 1) as usize;
                        sum += src[(sy * wi + sx) * 4 + c] as u32;
                        n += 1;
                    }
                }
                let blur = sum as f64 / n as f64;
                let center = src[i + c] as f64;
                out[i + c] = clamp_u8(center + amount * (center - blur));
            }
        }
    }
    out
}

/* ---------------- sidecar（可携带副本） ---------------- */

#[derive(Debug, Clone, PartialEq)]
pub struct SidecarRecord {
    pub stack: EditStack,
    pub source_size: u64,
    pub source_mtime_ns: i128,
    pub updated_at: i64,
}

/// `<图片目录>/.albumio/<文件名>.xmp`
pub fn sidecar_path(image: &Path) -> Option<PathBuf> {
    let parent = image.parent()?;
    let name = image.file_name()?;
    Some(parent.join(SIDECAR_DIR).join(format!("{}.xmp", name.to_string_lossy())))
}

pub fn read_sidecar(image: &Path) -> Result<Option<SidecarRecord>> {
    let Some(path) = sidecar_path(image) else {
        return Ok(None);
    };
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    Ok(Some(parse_sidecar(&text)?))
}

pub fn write_sidecar(image: &Path, record: &SidecarRecord) -> Result<()> {
    let path = sidecar_path(image).ok_or_else(|| Error::Invalid("图片路径没有父目录".into()))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let xml = render_sidecar(record)?;
    // 先写临时文件再 rename：半份 XMP 比没有更糟。
    let tmp = path.with_extension("xmp.tmp");
    std::fs::write(&tmp, xml)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

pub fn remove_sidecar(image: &Path) -> Result<()> {
    let Some(path) = sidecar_path(image) else {
        return Ok(());
    };
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    // 目录空了就收掉，不在照片目录里留一个空 `.albumio`。
    if let Some(dir) = path.parent() {
        let _ = std::fs::remove_dir(dir);
    }
    Ok(())
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn render_sidecar(r: &SidecarRecord) -> Result<String> {
    let ops = xml_escape(&r.stack.to_json()?);
    Ok(format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n\
 <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
  <rdf:Description rdf:about=\"\"\n\
    xmlns:albumio=\"https://albumio.app/ns/1.0/\"\n\
    albumio:StackVersion=\"{}\"\n\
    albumio:SourceSize=\"{}\"\n\
    albumio:SourceMtimeNs=\"{}\"\n\
    albumio:UpdatedAt=\"{}\">\n\
   <albumio:Ops>{}</albumio:Ops>\n\
  </rdf:Description>\n\
 </rdf:RDF>\n\
</x:xmpmeta>\n\
<?xpacket end=\"w\"?>\n",
        r.stack.v, r.source_size, r.source_mtime_ns, r.updated_at, ops
    ))
}

fn parse_sidecar(text: &str) -> Result<SidecarRecord> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(text);
    reader.config_mut().trim_text(true);

    let mut ops_text = String::new();
    let mut source_size = 0u64;
    let mut source_mtime_ns: i128 = 0;
    let mut updated_at: i64 = 0;
    let mut in_ops = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = e.name();
                let local = name.local_name();
                if local.as_ref() == b"Ops" {
                    in_ops = true;
                }
                for attr in e.attributes().flatten() {
                    let key = attr.key.local_name();
                    let value = String::from_utf8_lossy(&attr.value).to_string();
                    match key.as_ref() {
                        b"SourceSize" => source_size = value.parse().unwrap_or(0),
                        b"SourceMtimeNs" => source_mtime_ns = value.parse().unwrap_or(0),
                        b"UpdatedAt" => updated_at = value.parse().unwrap_or(0),
                        _ => {}
                    }
                }
            }
            Ok(Event::Text(t)) => {
                if in_ops {
                    let text = t
                        .unescape()
                        .map_err(|e| Error::Invalid(format!("sidecar 文本解码失败：{e}")))?;
                    ops_text.push_str(&text);
                }
            }
            Ok(Event::End(e)) => {
                if e.name().local_name().as_ref() == b"Ops" {
                    in_ops = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(Error::Invalid(format!("sidecar 解析失败：{e}"))),
            _ => {}
        }
    }

    let stack = EditStack::parse(&ops_text)?;
    Ok(SidecarRecord {
        stack,
        source_size,
        source_mtime_ns,
        updated_at,
    })
}

/// 原图被外部修改过：尺寸或 mtime 与保存时不同（`01-方案文档.md` §5.3）。
pub fn is_stale(record: &SidecarRecord, size: u64, mtime_ns: i128) -> bool {
    record.source_size != size || record.source_mtime_ns != mtime_ns
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, rgb: [u8; 3]) -> Vec<u8> {
        let mut v = vec![0u8; w as usize * h as usize * 4];
        for px in v.chunks_exact_mut(4) {
            px[0] = rgb[0];
            px[1] = rgb[1];
            px[2] = rgb[2];
            px[3] = 255;
        }
        v
    }

    fn gradient(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0u8; w as usize * h as usize * 4];
        for y in 0..h as usize {
            for x in 0..w as usize {
                let i = (y * w as usize + x) * 4;
                v[i] = (x * 255 / w as usize) as u8;
                v[i + 1] = (y * 255 / h as usize) as u8;
                v[i + 2] = ((x + y) * 255 / (w + h) as usize) as u8;
                v[i + 3] = 255;
            }
        }
        v
    }

    #[test]
    fn json_roundtrip_and_fixed_order() {
        let json = r#"{"v":1,"ops":[
            {"op":"sharpen","amount":0.4},
            {"op":"exposure","ev":0.35},
            {"op":"crop","rect":[0.1,0.1,0.5,0.5],"aspect":"1:1"},
            {"op":"orient","deg":90,"flip":false},
            {"op":"exposure","ev":0.5}
        ]}"#;
        let stack = EditStack::parse(json).unwrap();
        let keys: Vec<_> = stack.ops.iter().map(|o| o.key()).collect();
        assert_eq!(keys, vec!["orient", "crop", "exposure", "sharpen"]);
        assert_eq!(stack.ops[2], Op::Exposure { ev: 0.5 }, "重复的曝光取最后一次");
        assert_eq!(stack.ops[3], Op::Sharpen { amount: 0.4 });
        let again = EditStack::parse(&stack.to_json().unwrap()).unwrap();
        assert_eq!(stack, again, "序列化后再解析必须等价");
    }

    #[test]
    fn rejects_out_of_range() {
        assert!(EditStack::parse(r#"{"v":1,"ops":[{"op":"crop","rect":[0,0,1.2,1]}]}"#).is_err());
        assert!(EditStack::parse(r#"{"v":1,"ops":[{"op":"exposure","ev":9}]}"#).is_err());
        assert!(EditStack::parse(r#"{"v":1,"ops":[{"op":"orient","deg":45}]}"#).is_err());
    }

    #[test]
    fn orient_rotates_dimensions() {
        let stack = EditStack::parse(r#"{"v":1,"ops":[{"op":"orient","deg":90}]}"#).unwrap();
        let out = apply_ops(solid(4, 2, [10, 20, 30]), 4, 2, &stack).unwrap();
        assert_eq!((out.width, out.height), (2, 4));
        assert_eq!(out.rgba.len(), 2 * 4 * 4);
    }

    #[test]
    fn orient_flip_then_rotate() {
        // 左半红、右半蓝 → 水平翻转后左蓝右红 → 90° 顺时针后上蓝下红。
        let (w, h) = (4u32, 2u32);
        let mut src = solid(w, h, [255, 0, 0]);
        for y in 0..h as usize {
            for x in 2..4usize {
                let i = (y * w as usize + x) * 4;
                src[i] = 0;
                src[i + 2] = 255;
            }
        }
        let stack = EditStack::parse(r#"{"v":1,"ops":[{"op":"orient","deg":90,"flip":true}]}"#)
            .unwrap();
        let out = apply_ops(src, w, h, &stack).unwrap();
        assert_eq!((out.width, out.height), (2, 4));
        let px = |x: usize, y: usize| {
            let i = (y * 2 + x) * 4;
            [out.rgba[i], out.rgba[i + 1], out.rgba[i + 2]]
        };
        assert_eq!(px(0, 0), [0, 0, 255], "旋转后左上应为蓝");
        assert_eq!(px(0, 3), [255, 0, 0], "旋转后左下应为红");
    }

    #[test]
    fn crop_uses_normalized_coordinates() {
        let src = gradient(100, 50);
        let stack = EditStack::parse(
            r#"{"v":1,"ops":[{"op":"crop","rect":[0.25,0.2,0.5,0.6],"aspect":"free"}]}"#,
        )
        .unwrap();
        let out = apply_ops(src, 100, 50, &stack).unwrap();
        assert_eq!((out.width, out.height), (50, 30));
    }

    #[test]
    fn exposure_and_contrast_are_visible() {
        let stack = EditStack::parse(
            r#"{"v":1,"ops":[{"op":"exposure","ev":1},{"op":"contrast","k":0.5},{"op":"saturation","k":0.5},{"op":"sharpen","amount":0.4}]}"#,
        )
        .unwrap();
        let out = apply_ops(solid(8, 8, [100, 100, 100]), 8, 8, &stack).unwrap();
        assert!(out.rgba[0] > 100, "曝光 +1 EV 应提亮：{}", out.rgba[0]);
        assert_eq!(out.width, 8);
    }

    #[test]
    fn crop_is_resolution_independent() {
        // 同一组归一化参数作用在 2 倍尺寸上，裁出的相对内容一致（允许 ±1 像素）。
        let stack = EditStack::parse(
            r#"{"v":1,"ops":[{"op":"crop","rect":[0.2,0.25,0.5,0.5],"aspect":"1:1"}]}"#,
        )
        .unwrap();
        let big = apply_ops(gradient(200, 200), 200, 200, &stack).unwrap();
        let small = apply_ops(gradient(100, 100), 100, 100, &stack).unwrap();
        assert_eq!((small.width, small.height), (50, 50));
        assert_eq!((big.width, big.height), (100, 100));
        assert!((big.rgba[0] as i32 - small.rgba[0] as i32).abs() <= 2);
    }

    #[test]
    fn sidecar_roundtrip_and_stale() {
        let dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("DSC_0001.JPG");
        std::fs::write(&img, b"x").unwrap();
        let record = SidecarRecord {
            stack: EditStack::parse(r#"{"v":1,"ops":[{"op":"exposure","ev":0.35}]}"#).unwrap(),
            source_size: 1,
            source_mtime_ns: 123,
            updated_at: 456,
        };
        write_sidecar(&img, &record).unwrap();
        assert!(dir.path().join(".albumio").is_dir(), "sidecar 收在隐藏目录");
        assert_eq!(
            std::fs::read_dir(dir.path())
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().ends_with(".xmp"))
                .count(),
            0,
            "照片旁边不得散落 .xmp"
        );
        let back = read_sidecar(&img).unwrap().unwrap();
        assert_eq!(back, record);
        assert!(!is_stale(&back, 1, 123));
        assert!(is_stale(&back, 2, 123));
        remove_sidecar(&img).unwrap();
        assert!(read_sidecar(&img).unwrap().is_none());
        assert!(!dir.path().join(".albumio").exists(), "空目录应被收掉");
    }
}
