use albumio_core::cache::Level;
use albumio_core::{
    EntryStat, FileInfo, Index, IndexStatus, ListEntry, Listing, PhotoMeta, Pipeline, Priority,
};
use serde::Serialize;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::Manager;

pub struct DataDir(pub PathBuf);

/// 索引是旁路：打不开就为 None，浏览/看图/编辑/导出一切照常（folder-first）。
pub struct IndexState(pub Option<Index>);

/// 启动时传入的目录（`albumio <dir>`）。M9 的"默认打开方式"也走这条路。
pub struct StartDir(pub Option<String>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ListResponse {
    generation: u64,
    dir: String,
    entries: Vec<ListEntry>,
    elapsed_ms: u128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatResponse {
    generation: u64,
    cancelled: bool,
    stats: Vec<EntryStat>,
    elapsed_ms: u128,
}

/// 数据目录固定为 <系统 data 目录>/albumio（04-项目计划 M0：数据目录 albumio），
/// 不跟随 identifier 变化，避免改标识时丢缓存与索引。
fn data_dir(app: &tauri::AppHandle) -> io::Result<PathBuf> {
    let base = app
        .path()
        .data_dir()
        .map_err(|e| io::Error::other(e.to_string()))?;
    let dir = base.join("albumio");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// 探测：格式、尺寸、大小、mtime。不读像素。
#[tauri::command]
fn albumio_probe(pipeline: tauri::State<Pipeline>, path: String) -> Result<FileInfo, String> {
    pipeline
        .probe(std::path::Path::new(&path))
        .map_err(|e| e.to_string())
}

/// 取一级缩略图（WebP 字节）。命中缓存不解码。
#[tauri::command]
fn albumio_thumb(
    pipeline: tauri::State<Pipeline>,
    path: String,
    level: String,
) -> Result<tauri::ipc::Response, String> {
    let level = Level::from_name(&level).ok_or_else(|| format!("未知缩略图级别：{level}"))?;
    let r = pipeline
        .thumbnail(std::path::Path::new(&path), level)
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(r.bytes))
}

/// 只做 readdir（不含 stat）：进目录后的第一件事，毫秒级返回文件名。
/// 每次调用开启新 generation，旧目录的在途/排队 stat 全部作废（`docs/spike/S4.md`）。
#[tauri::command]
fn albumio_list(listing: tauri::State<Listing>, dir: String) -> Result<ListResponse, String> {
    let t0 = Instant::now();
    let generation = listing.begin_generation();
    let entries = albumio_core::listing::read_images(Path::new(&dir)).map_err(|e| e.to_string())?;
    Ok(ListResponse {
        generation,
        dir,
        entries,
        elapsed_ms: t0.elapsed().as_millis(),
    })
}

/// 按 P0–P4 优先级补 stat（大小/mtime）。generation 与当前目录不一致时整批作废。
#[tauri::command]
fn albumio_stat(
    listing: tauri::State<Listing>,
    paths: Vec<String>,
    priority: u8,
    generation: u64,
) -> Result<StatResponse, String> {
    let t0 = Instant::now();
    if generation != listing.generation() {
        return Ok(StatResponse {
            generation,
            cancelled: true,
            stats: Vec::new(),
            elapsed_ms: 0,
        });
    }
    let priority = Priority::from_u8(priority).ok_or_else(|| format!("优先级越界：{priority}"))?;
    listing.enqueue(&paths, priority, generation);
    let outcome = listing.drain(paths.len());
    Ok(StatResponse {
        generation,
        cancelled: outcome.cancelled,
        stats: outcome.stats,
        elapsed_ms: t0.elapsed().as_millis(),
    })
}

/// 检查器数据：EXIF/XMP 合并结果 + 直方图。顺带写索引（失败只记日志，不影响返回）。
#[tauri::command]
fn albumio_meta(
    pipeline: tauri::State<Pipeline>,
    index: tauri::State<IndexState>,
    path: String,
) -> Result<PhotoMeta, String> {
    let p = Path::new(&path);
    let mut meta = albumio_core::meta::read(p).map_err(|e| e.to_string())?;
    // 直方图用 L1 代理：像素已在管线里转过 sRGB，符合 `02-设计规范.md` §11.3 口径。
    if let Ok(thumb) = pipeline.thumbnail(p, Level::L1) {
        if let Ok(hist) = albumio_core::meta::histogram_webp(&thumb.bytes) {
            meta.histogram = hist;
        }
    }
    if let Some(idx) = &index.0 {
        if let Err(e) = idx.upsert(&meta) {
            eprintln!("[index] 写入失败（不影响看图）：{e}");
        }
    }
    Ok(meta)
}

#[tauri::command]
fn albumio_index_status(index: tauri::State<IndexState>) -> IndexStatus {
    match &index.0 {
        Some(idx) => idx.status().unwrap_or_default(),
        None => IndexStatus::default(),
    }
}

/// 删除：`permanent=false` 移到系统回收站（单文件 Delete 不弹框，§11.6.1），
/// `true` 永久删除。逐条返回成功/失败，不因单条失败中断整批。
#[tauri::command]
fn albumio_delete(paths: Vec<String>, permanent: bool) -> albumio_core::ops::DeleteOutcome {
    if permanent {
        albumio_core::ops::delete_permanent(&paths)
    } else {
        albumio_core::ops::move_to_trash(&paths)
    }
}

/// 撤销「移到回收站」：`since` 用 `albumio_delete` 返回的 `at`，避免还原同名旧条目。
#[tauri::command]
fn albumio_restore(paths: Vec<String>, since: i64) -> albumio_core::ops::DeleteOutcome {
    albumio_core::ops::restore(&paths, since)
}

/// 启动目录：命令行第一个参数是存在的目录就用它，否则返回 null（前端回退到"图片"目录）。
#[tauri::command]
fn albumio_start_dir(start: tauri::State<StartDir>) -> Option<String> {
    start.0.clone()
}

/* ---------------- 侧栏与时间线（04-项目计划 M3） ---------------- */

/// 树根：Windows 是盘符，Unix 是 `/` 与主目录。
#[tauri::command]
fn albumio_roots() -> Vec<albumio_core::nav::Root> {
    albumio_core::nav::roots()
}

/// 展开一层：只读直接子目录，顺带数各自的直接图片数（不递归）。
#[tauri::command]
fn albumio_dirs(dir: String) -> Result<Vec<albumio_core::nav::SubDir>, String> {
    albumio_core::nav::subdirs(Path::new(&dir)).map_err(|e| e.to_string())
}

/// 侧栏底部的磁盘用量块；取不到就返回 null，UI 不显示这一块。
#[tauri::command]
fn albumio_disk(dir: String) -> Option<albumio_core::nav::DiskInfo> {
    albumio_core::nav::disk(Path::new(&dir))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TakenRow {
    path: String,
    taken_at: i64,
    taken_at_text: Option<String>,
    source: String,
    failed: bool,
}

/// 时间线分桶用：只读拍摄时间（EXIF → XMP createDate → mtime 并标 inferred）。
/// 前端按批调用，单批失败只影响该批的条目（回退到 mtime）。
#[tauri::command]
fn albumio_taken(paths: Vec<String>) -> Vec<TakenRow> {
    paths
        .into_iter()
        .map(|path| match albumio_core::meta::taken_of(Path::new(&path)) {
            Ok(t) => TakenRow {
                path,
                taken_at: t.taken_at,
                taken_at_text: t.taken_at_text,
                source: format!("{:?}", t.source).to_lowercase(),
                failed: false,
            },
            Err(_) => TakenRow {
                path,
                taken_at: 0,
                taken_at_text: None,
                source: "inferred".into(),
                failed: true,
            },
        })
        .collect()
}

/// 程序图标的明暗两版（`design/assets/app-icon/` 的矢量源生成，256 px）。
/// Windows 的窗口/任务栏图标可以运行时替换，就跟着系统「应用模式」走；
/// macOS 的 Dock 与 Linux 的 .desktop 不做运行时切换，安装包统一用暗色那张。
#[cfg(target_os = "windows")]
fn theme_icon(theme: tauri::Theme) -> Option<tauri::image::Image<'static>> {
    let bytes: &'static [u8] = match theme {
        tauri::Theme::Dark => include_bytes!("../icons/theme/dark-256.png"),
        _ => include_bytes!("../icons/theme/light-256.png"),
    };
    let (rgba, w, h) = albumio_core::icon::decode_png_rgba(bytes).ok()?;
    Some(tauri::image::Image::new_owned(rgba, w, h))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = data_dir(app.handle())?;
            let pipeline = Pipeline::new(dir.join("thumbs"))
                .map_err(|e| io::Error::other(format!("缩略图缓存初始化失败：{e}")))?;
            let _ = pipeline.sweep();
            let start = std::env::args().nth(1).filter(|p| Path::new(p).is_dir());
            let index = match Index::open(dir.join("index.db")) {
                Ok(idx) => Some(idx),
                Err(e) => {
                    eprintln!("[index] 打不开（将按无索引运行）：{e}");
                    None
                }
            };
            app.manage(DataDir(dir));
            app.manage(StartDir(start));
            app.manage(pipeline);
            app.manage(Listing::new());
            app.manage(IndexState(index));
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                // 启动时先按当前系统主题放一次，之后由 ThemeChanged 接管。
                let theme = window.theme().unwrap_or(tauri::Theme::Dark);
                if let Some(icon) = theme_icon(theme) {
                    let _ = window.set_icon(icon);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "windows")]
            if let tauri::WindowEvent::ThemeChanged(theme) = event {
                if let Some(icon) = theme_icon(*theme) {
                    if let Err(e) = window.set_icon(icon) {
                        eprintln!("[icon] 切换窗口图标失败：{e}");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            albumio_probe,
            albumio_thumb,
            albumio_list,
            albumio_stat,
            albumio_meta,
            albumio_index_status,
            albumio_delete,
            albumio_restore,
            albumio_start_dir,
            albumio_roots,
            albumio_dirs,
            albumio_disk,
            albumio_taken
        ])
        .run(tauri::generate_context!())
        .expect("error while running albumio");
}
