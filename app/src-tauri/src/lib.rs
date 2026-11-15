use albumio_core::cache::Level;
use albumio_core::{EntryStat, FileInfo, ListEntry, Listing, Pipeline, Priority};
use serde::Serialize;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::Manager;

pub struct DataDir(pub PathBuf);

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

/// 启动目录：命令行第一个参数是存在的目录就用它，否则返回 null（前端回退到"图片"目录）。
#[tauri::command]
fn albumio_start_dir(start: tauri::State<StartDir>) -> Option<String> {
    start.0.clone()
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
            app.manage(DataDir(dir));
            app.manage(StartDir(start));
            app.manage(pipeline);
            app.manage(Listing::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            albumio_probe,
            albumio_thumb,
            albumio_list,
            albumio_stat,
            albumio_start_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running albumio");
}
