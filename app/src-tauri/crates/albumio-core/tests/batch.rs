use albumio_core::batch::{plan, run, BatchOptions, BatchProgress, BatchSource};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn dims(path: &Path) -> (u32, u32) {
    image::ImageReader::open(path)
        .unwrap()
        .with_guessed_format()
        .unwrap()
        .into_dimensions()
        .unwrap()
}

fn source(path: &Path) -> BatchSource {
    let (width, height) = dims(path);
    BatchSource {
        path: path.display().to_string(),
        name: path.file_name().unwrap().to_string_lossy().to_string(),
        width,
        height,
        size: fs::metadata(path).unwrap().len(),
        camera: "Sony A7M4".into(),
        date: "20240512".into(),
        time: "083107".into(),
    }
}

fn options(out: &Path) -> BatchOptions {
    BatchOptions {
        out_dir: out.display().to_string(),
        rename: false,
        pattern: String::new(),
        convert: false,
        format: "keep".into(),
        quality: 90,
        resize: "none".into(),
    }
}

fn copy(src: &str, dst: &Path) {
    fs::create_dir_all(dst.parent().unwrap()).unwrap();
    fs::copy(fixture(src), dst).unwrap();
}

#[test]
fn conflicts_get_suffix_and_never_overwrite() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    copy("orient-1.jpg", &root.join("a/same.jpg"));
    copy("orient-1.jpg", &root.join("b/same.jpg"));
    let sources = vec![
        source(&root.join("a/same.jpg")),
        source(&root.join("b/same.jpg")),
    ];

    let mut o = options(&root.join("out"));
    o.rename = true;
    o.pattern = "{原名}".into();
    o.convert = true;
    o.format = "jpeg".into();

    let p = plan(&sources, &o).unwrap();
    assert_eq!(p.conflicts, 1, "两条同名源应恰好 1 条冲突");
    let names: Vec<_> = p.items.iter().map(|i| i.out_name.clone()).collect();
    assert_eq!(names, vec!["same.jpg", "same_1.jpg"]);

    let outcome = run(&p, &AtomicBool::new(false), |_| {});
    assert_eq!(outcome.results.len(), 2);
    assert!(outcome.results.iter().all(|r| r.status == "done"));
    assert!(root.join("out/same.jpg").exists());
    assert!(root.join("out/same_1.jpg").exists());
    assert!(fs::metadata(root.join("a/same.jpg")).unwrap().len() > 0);

    // 目标目录里已有同名文件时也不能覆盖，规划阶段就追加序号。
    let p2 = plan(&sources, &o).unwrap();
    assert!(
        p2.items[0].out_name.starts_with("same_"),
        "已存在的输出应被避开"
    );
    assert!(p2.items[0].conflict);
}

#[test]
fn unchanged_output_is_skipped() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("keep.jpg");
    copy("orient-1.jpg", &src);
    let before = fs::read(&src).unwrap();

    let p = plan(&[source(&src)], &options(tmp.path())).unwrap();
    assert_eq!(p.skipped, 1);
    assert!(p.items[0].skip.as_deref().unwrap().contains("无需处理"));

    let outcome = run(&p, &AtomicBool::new(false), |_| {});
    assert_eq!(outcome.results[0].status, "skipped");
    assert_eq!(fs::read(&src).unwrap(), before, "跳过时源文件必须原样不动");
}

#[test]
fn corrupt_source_fails_with_reason_not_silence() {
    let tmp = tempfile::tempdir().unwrap();
    let bad = tmp.path().join("broken.jpg");
    fs::write(&bad, b"not an image at all").unwrap();

    let p = plan(&[source_of_broken(&bad)], &options(&tmp.path().join("out"))).unwrap();
    let outcome = run(&p, &AtomicBool::new(false), |_| {});
    assert_eq!(outcome.results.len(), 1);
    assert_eq!(outcome.results[0].status, "failed");
    let reason = outcome.results[0].reason.as_deref().unwrap();
    assert!(
        reason.contains("源文件不可读"),
        "失败原因应逐条可读：{reason}"
    );
}

fn source_of_broken(path: &Path) -> BatchSource {
    BatchSource {
        path: path.display().to_string(),
        name: "broken.jpg".into(),
        width: 100,
        height: 100,
        size: 19,
        camera: String::new(),
        date: String::new(),
        time: String::new(),
    }
}

#[test]
fn convert_and_resize_outputs_real_files() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let big = root.join("src/big.jpg");
    let png = root.join("src/sample.png");
    let webp = root.join("src/sample.webp");
    copy("big-4000x3000.jpg", &big);
    copy("sample.png", &png);
    copy("sample.webp", &webp);
    let before = fs::read(&big).unwrap();

    let sources = vec![source(&big), source(&png), source(&webp)];
    let mut o = options(&root.join("out"));
    o.convert = true;
    o.format = "jpeg".into();
    o.resize = "long2048".into();

    let p = plan(&sources, &o).unwrap();
    assert_eq!((p.items[0].width, p.items[0].height), (2048, 1536));
    assert!(p.summary.contains("JPEG"), "摘要：{}", p.summary);
    assert!(p.summary.contains("长边 2048"), "摘要：{}", p.summary);

    let outcome = run(&p, &AtomicBool::new(false), |_| {});
    assert!(outcome.results.iter().all(|r| r.status == "done"));
    assert_eq!(dims(&root.join("out/big.jpg")), (2048, 1536));
    assert_eq!(fs::read(&big).unwrap(), before, "源图不能被改写");
    for r in &outcome.results {
        assert!(Path::new(r.out.as_ref().unwrap()).exists());
    }
}

#[test]
fn hundred_mixed_formats_all_succeed() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let src_dir = root.join("src");
    fs::create_dir_all(&src_dir).unwrap();

    let pool = [
        ("sample.png", "png"),
        ("sample.webp", "webp"),
        ("sample.bmp", "bmp"),
        ("orient-1.jpg", "jpg"),
        ("sample.tiff", "tiff"),
    ];
    let mut sources = Vec::new();
    for i in 0..97 {
        let (fixture_name, ext) = pool[i % pool.len()];
        let path = src_dir.join(format!("img_{i:03}.{ext}"));
        copy(fixture_name, &path);
        sources.push(source(&path));
    }
    // 同名冲突：两个不同目录下的同名文件。
    copy("orient-1.jpg", &root.join("d1/dup.jpg"));
    copy("orient-1.jpg", &root.join("d2/dup.jpg"));
    sources.push(source(&root.join("d1/dup.jpg")));
    sources.push(source(&root.join("d2/dup.jpg")));
    // 损坏文件。
    let bad = src_dir.join("broken.jpg");
    fs::write(&bad, b"broken bytes").unwrap();
    sources.push(source_of_broken(&bad));

    assert_eq!(sources.len(), 100);

    let out = root.join("out");
    let mut o = options(&out);
    o.rename = true;
    o.pattern = "{原名}_{序号}".into();
    o.convert = true;
    o.format = "jpeg".into();
    o.resize = "long1280".into();

    let p = plan(&sources, &o).unwrap();
    let outcome = run(&p, &AtomicBool::new(false), |_| {});

    let done = outcome
        .results
        .iter()
        .filter(|r| r.status == "done")
        .count();
    let failed = outcome
        .results
        .iter()
        .filter(|r| r.status == "failed")
        .count();
    assert_eq!(done, 99, "应 99 张成功");
    assert_eq!(failed, 1, "应 1 张失败");
    assert!(outcome.results.iter().any(|r| r
        .reason
        .as_deref()
        .is_some_and(|x| x.contains("源文件不可读"))));

    let outputs: Vec<_> = outcome
        .results
        .iter()
        .filter_map(|r| r.out.clone())
        .collect();
    assert_eq!(outputs.len(), 99);
    let unique: std::collections::HashSet<_> = outputs.iter().cloned().collect();
    assert_eq!(unique.len(), 99, "输出名不得重复（无冲突、无覆盖）");
    for path in &outputs {
        assert!(
            !sources.iter().any(|s| s.path == *path),
            "输出路径不能等于源路径"
        );
        assert!(Path::new(path).exists());
    }
    let parts = fs::read_dir(&out)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().to_string_lossy().ends_with(".part"))
        .count();
    assert_eq!(parts, 0, "不得残留 .part 临时文件");
}

#[test]
fn cancel_stops_at_file_boundary_and_cleans_parts() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let mut sources = Vec::new();
    for i in 0..5 {
        let path = root.join(format!("src/big_{i}.jpg"));
        copy("big-4000x3000.jpg", &path);
        sources.push(source(&path));
    }

    let mut o = options(&root.join("out"));
    o.convert = true;
    o.format = "jpeg".into();
    o.resize = "long2048".into();

    let p = plan(&sources, &o).unwrap();
    let cancel = AtomicBool::new(false);
    let outcome = run(&p, &cancel, |ev: BatchProgress| {
        if ev.phase == "item" {
            cancel.store(true, Ordering::Relaxed);
        }
    });

    assert!(outcome.cancelled);
    assert_eq!(outcome.results.len(), 1, "取消后不应继续处理下一张");
    let first = &outcome.results[0];
    assert_eq!(first.status, "done");
    let out = Path::new(first.out.as_ref().unwrap());
    assert!(out.exists());
    assert_eq!(dims(out), (2048, 1536), "已完成的文件必须可正常打开");
    let parts = fs::read_dir(root.join("out"))
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().to_string_lossy().ends_with(".part"))
        .count();
    assert_eq!(parts, 0, "取消后不得残留临时文件");
}

#[test]
fn jpeg_output_embeds_srgb_and_resets_orientation() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("rotated.jpg");
    copy("orient-6.jpg", &src);

    let mut o = options(&tmp.path().join("out"));
    o.convert = true;
    o.format = "jpeg".into();
    let p = plan(&[source(&src)], &o).unwrap();
    let outcome = run(&p, &AtomicBool::new(false), |_| {});
    assert_eq!(outcome.results[0].status, "done");

    let bytes = fs::read(tmp.path().join("out/rotated.jpg")).unwrap();
    assert!(
        bytes.windows(12).any(|w| w == b"ICC_PROFILE\0"),
        "JPEG 应嵌入 ICC profile"
    );
    let mut cursor = std::io::Cursor::new(&bytes[..]);
    let exif = exif::Reader::new()
        .read_from_container(&mut cursor)
        .unwrap();
    let orientation = exif
        .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0));
    assert!(
        orientation.is_none() || orientation == Some(1),
        "输出像素已转正，EXIF Orientation 必须为 1：{orientation:?}"
    );
    // 落盘已转正：orient-6 是 40×20 顺时针 90°，输出 20×40。
    assert_eq!(dims(&tmp.path().join("out/rotated.jpg")), (20, 40));
}
