use albumio_core::cache::Level;
use albumio_core::decode::decode_bytes;
use albumio_core::orient::apply_orientation;
use albumio_core::pipeline::Pipeline;
use albumio_core::probe::probe_bytes;
use albumio_core::{color, ImageFormat};
use std::fs;
use std::path::{Path, PathBuf};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn rgba_at(rgba: &[u8], w: u32, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * w + x) * 4) as usize;
    [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
}

/// 取角落 2×2 的平均色，避免单像素抗锯齿影响判定。
fn corner(rgba: &[u8], w: u32, h: u32, corner: &str) -> [u8; 3] {
    let (x0, y0) = match corner {
        "tl" => (0, 0),
        "tr" => (w - 2, 0),
        "bl" => (0, h - 2),
        _ => (w - 2, h - 2),
    };
    let mut acc = [0u32; 3];
    for dy in 0..2 {
        for dx in 0..2 {
            let px = rgba_at(rgba, w, x0 + dx, y0 + dy);
            for i in 0..3 {
                acc[i] += px[i] as u32;
            }
        }
    }
    [(acc[0] / 4) as u8, (acc[1] / 4) as u8, (acc[2] / 4) as u8]
}

fn is_green(c: [u8; 3]) -> bool {
    c[1] > 180 && c[0] < 110 && c[2] < 110
}

#[test]
fn orientation_matrix_full_resolution() {
    // 绿色标记在存储图的左上角；Orientation 决定它显示在哪个角。
    let expected = [
        (1u8, (40u32, 20u32), "tl"),
        (2, (40, 20), "tr"),
        (3, (40, 20), "br"),
        (4, (40, 20), "bl"),
        (5, (20, 40), "tl"),
        (6, (20, 40), "tr"),
        (7, (20, 40), "br"),
        (8, (20, 40), "bl"),
    ];
    for (o, (dw, dh), marker) in expected {
        let path = fixture(&format!("orient-{o}.jpg"));
        let bytes = fs::read(&path).unwrap();
        let d = decode_bytes(&bytes, ImageFormat::Jpeg, None).unwrap();
        assert_eq!(d.orientation, o, "orient-{o}.jpg 的 EXIF 方向未被读出");
        let (rgba, w, h) = apply_orientation(d.rgba, d.width, d.height, d.orientation);
        assert_eq!((w, h), (dw, dh), "Orientation {o} 输出尺寸不对");

        let marker_ok = match marker {
            "tl" => is_green(corner(&rgba, w, h, "tl")),
            "tr" => is_green(corner(&rgba, w, h, "tr")),
            "bl" => is_green(corner(&rgba, w, h, "bl")),
            _ => is_green(corner(&rgba, w, h, "br")),
        };
        assert!(
            marker_ok,
            "Orientation {o} 的绿色标记不在 {marker}，实际角：tl={:?} tr={:?} bl={:?} br={:?}",
            corner(&rgba, w, h, "tl"),
            corner(&rgba, w, h, "tr"),
            corner(&rgba, w, h, "bl"),
            corner(&rgba, w, h, "br"),
        );
    }
}

#[test]
fn thumbnail_applies_orientation() {
    let tmp = tempfile::tempdir().unwrap();
    let p = Pipeline::new(tmp.path().join("thumbs")).unwrap();
    let r = p.thumbnail(&fixture("orient-6.jpg"), Level::L1).unwrap();
    assert_eq!((r.width, r.height), (20, 40), "L1 必须已应用 Orientation");
    assert!(!r.cached);
    let img = image::load_from_memory_with_format(&r.bytes, image::ImageFormat::WebP)
        .unwrap()
        .to_rgba8();
    assert_eq!((img.width(), img.height()), (20, 40));
}

#[test]
fn second_call_hits_cache_without_decoding() {
    let tmp = tempfile::tempdir().unwrap();
    let p = Pipeline::new(tmp.path().join("thumbs")).unwrap();
    let f = fixture("big-4000x3000.jpg");
    let first = p.thumbnail(&f, Level::L1).unwrap();
    assert!(!first.cached);
    let second = p.thumbnail(&f, Level::L1).unwrap();
    assert!(second.cached, "同一文件第二次必须命中缓存");
    assert_eq!(first.key, second.key);
    assert_eq!(first.bytes, second.bytes);
    assert!(
        second.elapsed_ms <= first.elapsed_ms,
        "命中缓存不应比首次生成更慢：{} vs {}",
        second.elapsed_ms,
        first.elapsed_ms
    );
}

#[test]
fn mtime_change_changes_key_and_keeps_old_entry() {
    let tmp = tempfile::tempdir().unwrap();
    let p = Pipeline::new(tmp.path().join("thumbs")).unwrap();
    let work = tmp.path().join("a.jpg");
    fs::copy(fixture("orient-1.jpg"), &work).unwrap();

    let k1 = p.thumbnail(&work, Level::L1).unwrap().key;
    let old_path = p.cache().path_for(Level::L1, &k1);

    let f = fs::OpenOptions::new().write(true).open(&work).unwrap();
    f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5))
        .unwrap();
    drop(f);

    let k2 = p.thumbnail(&work, Level::L1).unwrap().key;
    assert_ne!(k1, k2, "mtime 变化必须换 key");
    assert!(old_path.exists(), "旧 key 文件不应被覆盖或删除");
    assert!(p.cache().path_for(Level::L1, &k2).exists());
}

#[test]
fn cmyk_jpeg_converts_to_expected_rgb() {
    let bytes = fs::read(fixture("cmyk.jpg")).unwrap();
    let d = decode_bytes(&bytes, ImageFormat::Jpeg, None).unwrap();
    assert_eq!((d.width, d.height), (32, 8));
    let white = rgba_at(&d.rgba, d.width, 2, 2);
    let red = rgba_at(&d.rgba, d.width, 10, 2);
    let cyan = rgba_at(&d.rgba, d.width, 18, 2);
    let black = rgba_at(&d.rgba, d.width, 28, 2);
    assert!(
        white[0] > 240 && white[1] > 240 && white[2] > 240,
        "白块={white:?}"
    );
    assert!(red[0] > 200 && red[1] < 60 && red[2] < 60, "红块={red:?}");
    assert!(
        cyan[0] < 60 && cyan[1] > 200 && cyan[2] > 200,
        "青块={cyan:?}"
    );
    assert!(
        black[0] < 40 && black[1] < 40 && black[2] < 40,
        "黑块={black:?}"
    );
}

#[test]
fn icc_profile_is_extracted_and_transform_succeeds() {
    let bytes = fs::read(fixture("icc-srgb.jpg")).unwrap();
    let d = decode_bytes(&bytes, ImageFormat::Jpeg, None).unwrap();
    let icc = d.icc.as_ref().expect("带 ICC 的 JPEG 必须抽出 profile");
    let mut px = d.rgba.clone();
    assert!(color::to_srgb(&mut px, Some(icc)).unwrap());
}

#[test]
fn other_containers_decode() {
    for (name, fmt) in [
        ("sample.png", ImageFormat::Png),
        ("sample.bmp", ImageFormat::Bmp),
        ("sample.tiff", ImageFormat::Tiff),
        ("sample.webp", ImageFormat::WebP),
    ] {
        let bytes = fs::read(fixture(name)).unwrap();
        assert_eq!(probe_bytes(&bytes), Some(fmt), "{name} 魔数探测不对");
        let d = decode_bytes(&bytes, fmt, None).unwrap();
        assert_eq!((d.width, d.height), (40, 20), "{name} 尺寸不对");
        assert_eq!(d.orientation, 1);
    }
}

/// 伪造的 HEIC 头：
/// - 内置 libheif 的构建（macOS/Linux）由 libheif 报 Decode；
/// - 未接入 HEIC 的构建仍是可判定的 Unsupported；
/// - Windows 由系统 WIC 报格式错误。
/// 共同的不变量只有一条：必须是 Err——界面不能拿到一张空白图还当成功。
/// （RC5 起 macOS/Linux 内置 libheif，原来的 "非 Windows 一律 Unsupported" 已经过时。）
#[test]
fn corrupt_heic_reports_error() {
    let tmp = tempfile::tempdir().unwrap();
    let p = Pipeline::new(tmp.path().join("thumbs")).unwrap();
    let path = tmp.path().join("fake.heic");
    let mut head = vec![0u8; 64];
    head[4..8].copy_from_slice(b"ftyp");
    head[8..12].copy_from_slice(b"heic");
    fs::write(&path, &head).unwrap();
    let err = p.thumbnail(&path, Level::L1).unwrap_err();
    #[cfg(not(windows))]
    assert!(
        matches!(
            err,
            albumio_core::Error::Decode(_) | albumio_core::Error::Unsupported { .. }
        ),
        "损坏的 HEIC 必须报错，实际 {err}"
    );
    #[cfg(windows)]
    assert!(
        matches!(err, albumio_core::Error::Decode(_)),
        "WIC 应报解码错误，实际 {err}"
    );
}

#[test]
fn perf_budget_for_l1_and_l0() {
    let tmp = tempfile::tempdir().unwrap();
    let p = Pipeline::new(tmp.path().join("thumbs")).unwrap();
    let f = fixture("big-4000x3000.jpg");
    let l0 = p.thumbnail(&f, Level::L0).unwrap();
    println!(
        "L0 4000×3000: {} ms, {} B, {}×{}",
        l0.elapsed_ms,
        l0.bytes.len(),
        l0.width,
        l0.height
    );
    assert!(l0.width.max(l0.height) == 32);
    assert!(
        l0.bytes.len() < 1024,
        "L0 应 < 1KB，实际 {}",
        l0.bytes.len()
    );

    // 冷/热各测一次：首次含文件读取，第二次模拟"同一图未缓存但文件已在页缓存"。
    let l1 = p.thumbnail(&f, Level::L1).unwrap();
    println!(
        "L1 4000×3000: {} ms, {} B, {}×{}",
        l1.elapsed_ms,
        l1.bytes.len(),
        l1.width,
        l1.height
    );
    assert_eq!(l1.width.max(l1.height), 256);
    // 预算（01-方案文档 §3）：p50 ≤ 95ms；这里只用单次采样，给 1s 宽限避免抖动。
    // 只在 release 下断言耗时：debug 未优化，同一张图在本机是 1.1s vs release 94ms，
    // 拿 debug 数字判定预算会把"编译选项"误判成"实现不合格"。
    if cfg!(debug_assertions) {
        println!("debug 构建：跳过耗时断言（release 实测见 docs/acceptance/M2.md）");
        return;
    }
    assert!(
        l1.elapsed_ms < 1000,
        "L1 耗时 {} ms 明显超预算",
        l1.elapsed_ms
    );
}

/// M6 验收：预览与导出同一组参数结果一致、原图字节不变、导出不覆盖同名。
#[test]
fn edit_preview_and_export_agree_without_touching_original() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("sample.jpg");
    fs::copy(fixture("orient-1.jpg"), &src).unwrap();
    let before = fs::read(&src).unwrap();

    let pipeline = Pipeline::new(tmp.path().join("cache")).unwrap();
    let ops = r#"{"v":1,"ops":[
        {"op":"exposure","ev":0.5},
        {"op":"contrast","k":0.2},
        {"op":"saturation","k":0.3},
        {"op":"crop","rect":[0.1,0.1,0.8,0.8],"aspect":"free"}
    ]}"#;
    let stack = albumio_core::edit::EditStack::parse(ops).unwrap();

    let preview = pipeline.edit_preview(&src, &stack).unwrap();
    let first = pipeline.export(&src, &stack).unwrap();
    let second = pipeline.export(&src, &stack).unwrap();

    assert_eq!(before, fs::read(&src).unwrap(), "原图字节必须一个不差");
    assert_ne!(first.path, second.path, "同名导出必须让路而不是覆盖");
    assert!(second.path.ends_with("_Albumio_1.jpg"));

    let pv = image::load_from_memory_with_format(&preview, image::ImageFormat::WebP)
        .unwrap()
        .to_rgba8();
    let ex = image::load_from_memory(&fs::read(&first.path).unwrap())
        .unwrap()
        .to_rgba8();
    assert_eq!((pv.width(), pv.height()), (ex.width(), ex.height()));
    assert_eq!((first.width, first.height), (pv.width(), pv.height()));

    let mut total = 0u64;
    let mut n = 0u64;
    for (a, b) in pv.pixels().zip(ex.pixels()) {
        for c in 0..3 {
            total += (a[c] as i32 - b[c] as i32).unsigned_abs() as u64;
            n += 1;
        }
    }
    let mean = total as f64 / n as f64;
    println!("预览(WebP q80) vs 导出(JPEG q90) 平均像素差：{mean:.2}");
    assert!(mean < 8.0, "预览与导出平均差 {mean:.2} 过大");
}

/// 打印各阶段耗时与"分数解码是否生效"，作为验收记录的数据来源。
#[test]
fn stage_timings_report() {
    use albumio_core::thumb::{fit_dims, resize_rgba};
    use std::time::Instant;

    let bytes = fs::read(fixture("big-4000x3000.jpg")).unwrap();
    for edge in [256u32, 512] {
        let t = Instant::now();
        let d = decode_bytes(&bytes, ImageFormat::Jpeg, Some(edge)).unwrap();
        let decode_ms = t.elapsed().as_millis();
        let (tw, th) = fit_dims(d.width, d.height, edge / 2);
        let t = Instant::now();
        let _ = resize_rgba(&d.rgba, d.width, d.height, tw, th).unwrap();
        let resize_ms = t.elapsed().as_millis();
        println!(
            "target_edge={edge}: decode {decode_ms} ms ({}×{}), resize {resize_ms} ms -> {tw}×{th}",
            d.width, d.height
        );
    }
}
