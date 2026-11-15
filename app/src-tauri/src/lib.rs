use albumio_core::cache::Level;
use albumio_core::{FileInfo, Pipeline};
use std::io;
use std::path::PathBuf;
use tauri::Manager;

pub struct DataDir(pub PathBuf);

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = data_dir(app.handle())?;
            let pipeline = Pipeline::new(dir.join("thumbs"))
                .map_err(|e| io::Error::other(format!("缩略图缓存初始化失败：{e}")))?;
            let _ = pipeline.sweep();
            app.manage(DataDir(dir));
            app.manage(pipeline);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![albumio_probe, albumio_thumb])
        .run(tauri::generate_context!())
        .expect("error while running albumio");
}
