use albumio_core::cache::Level;
use albumio_core::{
    Debounce, DirWatcher, EntryStat, FileInfo, Index, IndexStatus, ListEntry, Listing, PhotoMeta,
    Pipeline, Priority,
};
use serde::Serialize;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::{Emitter, Manager};

pub struct DataDir(pub PathBuf);

/// 批量处理的取消标志：同一时间只跑一个任务（屏 4 是独占的）。
pub struct BatchState(pub Arc<AtomicBool>);

/// 索引是旁路：打不开就为 None，浏览/看图/编辑/导出一切照常（folder-first）。
pub struct IndexState(pub Option<Index>);

/// 当前目录监听（屏 1 一次只看一个目录，换目录时先停旧的）。
pub struct WatchState(pub Mutex<Option<DirWatcher>>);

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

/// 开始监听当前目录（非递归）。换目录时先停旧监听，避免两个目录的批次串台。
/// 每批增量通过 `albumio://dir-changed` 推送；`overflow=true` 时前端整目录重建。
#[tauri::command]
fn albumio_watch_start(
    app: tauri::AppHandle,
    state: tauri::State<WatchState>,
    dir: String,
) -> Result<(), String> {
    let mut slot = state.0.lock().map_err(|e| e.to_string())?;
    *slot = None;
    let watcher = DirWatcher::start(Path::new(&dir), Debounce::default(), move |changes| {
        let _ = app.emit("albumio://dir-changed", changes);
    })
    .map_err(|e| e.to_string())?;
    *slot = Some(watcher);
    Ok(())
}

/// 停止监听：`F5` 手动刷新、切换视图或窗口关闭时调用。
#[tauri::command]
fn albumio_watch_stop(state: tauri::State<WatchState>) -> Result<(), String> {
    *state.0.lock().map_err(|e| e.to_string())? = None;
    Ok(())
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

/* ---------------- 非破坏性编辑（04-项目计划 M6） ---------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EditLoad {
    /// 空字符串代表没有编辑；前端据此还原成空栈。
    ops: String,
    /// 原图在保存后被外部改过（大小或 mtime 变了）。
    stale: bool,
    /// `sidecar` / `index` / `none`，冲突时取更新时间较晚者。
    source: String,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EditSave {
    saved: bool,
    warnings: Vec<String>,
}

/// 读编辑栈：sidecar 与 SQLite 各存一份，取较新的；索引被删也不丢编辑（folder-first）。
#[tauri::command]
fn albumio_edits_load(
    index: tauri::State<IndexState>,
    path: String,
) -> Result<EditLoad, String> {
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    let size = meta.len();
    let mtime = albumio_core::cache::mtime_ns(&meta);

    let sidecar = albumio_core::edit::read_sidecar(p).map_err(|e| e.to_string())?;
    let db = match &index.0 {
        Some(idx) => idx.edits_get(&path).map_err(|e| e.to_string())?,
        None => None,
    };

    let sidecar_stale = sidecar
        .as_ref()
        .map(|s| albumio_core::edit::is_stale(s, size, mtime))
        .unwrap_or(false);

    // sidecar 更新（>=）时优先，平局也当 sidecar 为准：它跟着照片走。
    match (sidecar, db) {
        (Some(s), Some((ops, at))) => {
            if s.updated_at >= at {
                Ok(EditLoad {
                    ops: s.stack.to_json().map_err(|e| e.to_string())?,
                    stale: sidecar_stale,
                    source: "sidecar".into(),
                    updated_at: s.updated_at,
                })
            } else {
                Ok(EditLoad {
                    ops,
                    stale: false,
                    source: "index".into(),
                    updated_at: at,
                })
            }
        }
        (Some(s), None) => Ok(EditLoad {
            ops: s.stack.to_json().map_err(|e| e.to_string())?,
            stale: sidecar_stale,
            source: "sidecar".into(),
            updated_at: s.updated_at,
        }),
        (None, Some((ops, at))) => Ok(EditLoad {
            ops,
            stale: false,
            source: "index".into(),
            updated_at: at,
        }),
        (None, None) => Ok(EditLoad {
            ops: String::new(),
            stale: false,
            source: "none".into(),
            updated_at: 0,
        }),
    }
}

/// 存编辑栈：先落 sidecar（可携带），再写索引（加速）。空栈 = 清除。
#[tauri::command]
fn albumio_edits_save(
    index: tauri::State<IndexState>,
    path: String,
    ops: String,
) -> Result<EditSave, String> {
    let p = Path::new(&path);
    let mut stack = albumio_core::edit::EditStack::parse(&ops).map_err(|e| e.to_string())?;

    if stack.is_empty() {
        albumio_core::edit::remove_sidecar(p).map_err(|e| e.to_string())?;
        if let Some(idx) = &index.0 {
            idx.edits_clear(&path).map_err(|e| e.to_string())?;
        }
        return Ok(EditSave {
            saved: true,
            warnings: Vec::new(),
        });
    }

    stack.normalize().map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    let record = albumio_core::edit::SidecarRecord {
        stack,
        source_size: meta.len(),
        source_mtime_ns: albumio_core::cache::mtime_ns(&meta),
        updated_at: albumio_core::edit::now_ms(),
    };

    let mut warnings = Vec::new();
    let mut sidecar_ok = true;
    if let Err(e) = albumio_core::edit::write_sidecar(p, &record) {
        sidecar_ok = false;
        warnings.push(format!("编辑副本写入失败：{e}"));
    }
    let mut index_ok = false;
    match &index.0 {
        Some(idx) => match idx.edits_set(&path, &record.stack.to_json().map_err(|e| e.to_string())?) {
            Ok(_) => index_ok = true,
            Err(e) => warnings.push(format!("索引写入失败：{e}")),
        },
        None => warnings.push("索引不可用，编辑只存于目录副本".into()),
    }
    if !sidecar_ok && !index_ok {
        return Err(warnings.join("；"));
    }
    Ok(EditSave {
        saved: true,
        warnings,
    })
}

/// 预览：L2 代理 + apply_ops，返回 WebP 字节（不缓存，参数随时在变）。
#[tauri::command]
fn albumio_edit_preview(
    pipeline: tauri::State<Pipeline>,
    path: String,
    ops: String,
) -> Result<tauri::ipc::Response, String> {
    let stack = albumio_core::edit::EditStack::parse(&ops).map_err(|e| e.to_string())?;
    let bytes = pipeline
        .edit_preview(Path::new(&path), &stack)
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 导出副本：原图全尺寸重放 apply_ops，JPEG q90，写 `原名_Albumio.jpg`。
#[tauri::command]
fn albumio_edit_export(
    pipeline: tauri::State<Pipeline>,
    path: String,
    ops: String,
) -> Result<albumio_core::ExportResult, String> {
    let stack = albumio_core::edit::EditStack::parse(&ops).map_err(|e| e.to_string())?;
    pipeline
        .export(Path::new(&path), &stack)
        .map_err(|e| e.to_string())
}

/* ---------------- 批量处理（04-项目计划 M7 / 屏 4） ---------------- */

/// 规划：输出名、冲突、预计尺寸都不落盘，只读文件头与 EXIF 方向。
#[tauri::command]
fn albumio_batch_plan(
    sources: Vec<albumio_core::BatchSource>,
    options: albumio_core::BatchOptions,
) -> Result<albumio_core::BatchPlan, String> {
    albumio_core::batch::plan(&sources, &options).map_err(|e| e.to_string())
}

/// 执行：在阻塞线程里逐条处理，每条结果通过 `albumio://batch-progress` 推送。
#[tauri::command]
async fn albumio_batch_run(
    app: tauri::AppHandle,
    items: Vec<albumio_core::BatchPlanItem>,
) -> Result<albumio_core::BatchOutcome, String> {
    let cancel = app.state::<BatchState>().0.clone();
    cancel.store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        albumio_core::batch::run(&items, &cancel, |progress| {
            let _ = app.emit("albumio://batch-progress", progress);
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn albumio_batch_cancel(state: tauri::State<BatchState>) {
    state.0.store(true, Ordering::Relaxed);
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
            app.manage(BatchState(Arc::new(AtomicBool::new(false))));
            app.manage(WatchState(Mutex::new(None)));
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
            albumio_watch_start,
            albumio_watch_stop,
            albumio_meta,
            albumio_index_status,
            albumio_delete,
            albumio_restore,
            albumio_start_dir,
            albumio_roots,
            albumio_dirs,
            albumio_disk,
            albumio_taken,
            albumio_edits_load,
            albumio_edits_save,
            albumio_edit_preview,
            albumio_edit_export,
            albumio_batch_plan,
            albumio_batch_run,
            albumio_batch_cancel
        ])
        .run(tauri::generate_context!())
        .expect("error while running albumio");
}
