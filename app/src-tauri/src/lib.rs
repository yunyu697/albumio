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

/// 启动时传入的目标（`albumio <路径>`）：目录或单个图片文件。
/// M9 的"默认打开方式"（双击关联文件）也走这条路。
pub struct StartTarget(pub Option<String>);

/// 单实例（M9）：第二个进程的启动参数要交给已运行的主窗口。
/// 主窗口前端可能还没挂上事件监听，用这个槽兜住那段窗口期；前端启动后取一次（取走即清空）。
pub struct PendingTarget(pub Mutex<Option<String>>);

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

/// 启动/拖放目标：要打开的目录 + 要在看图里定位的文件（目录目标时为空）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchTarget {
    dir: Option<String>,
    file: Option<String>,
}

/// 目录原样打开；文件打开其父目录并定位到该文件；路径不存在则两项皆空。
fn resolve_target(path: &Path) -> LaunchTarget {
    if path.is_dir() {
        return LaunchTarget {
            dir: Some(path.to_string_lossy().into_owned()),
            file: None,
        };
    }
    if path.is_file() {
        return LaunchTarget {
            dir: path.parent().map(|p| p.to_string_lossy().into_owned()),
            file: Some(path.to_string_lossy().into_owned()),
        };
    }
    LaunchTarget {
        dir: None,
        file: None,
    }
}

/// 启动目标：命令行第一个参数（M9 默认打开方式会以文件路径调用）。
#[tauri::command]
fn albumio_launch_target(start: tauri::State<StartTarget>) -> LaunchTarget {
    match &start.0 {
        Some(p) => resolve_target(Path::new(p)),
        None => LaunchTarget {
            dir: None,
            file: None,
        },
    }
}

/// 拖放共用：把外部给的一个路径变成「目录 + 可选文件」。
#[tauri::command]
fn albumio_resolve_target(path: String) -> LaunchTarget {
    resolve_target(Path::new(&path))
}

/// 单实例：从第二进程的 argv 里挑出要打开的目标。argv[0] 是可执行文件，跳过；
/// 选项参数（`-` 开头）不算目标；只认真实存在的路径。
fn target_from_args(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).exists())
        .cloned()
}

/// 取走第二实例暂存的目标（前端启动时调一次）：双击第二个关联文件时复用主窗口。
#[tauri::command]
fn albumio_take_pending(state: tauri::State<PendingTarget>) -> LaunchTarget {
    let path = state.0.lock().ok().and_then(|mut slot| slot.take());
    match path {
        Some(p) => resolve_target(Path::new(&p)),
        None => LaunchTarget {
            dir: None,
            file: None,
        },
    }
}

/// 剪贴板里已复制的文件列表（M9）：资源管理器/Finder 里复制图片后 Ctrl/Cmd+V 打开。
/// 剪贴板里不是文件时返回空数组；平台能力或工具缺失时返回可读的错误。
#[tauri::command]
fn albumio_clipboard_files() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        clipboard_files_windows()
    }
    #[cfg(target_os = "macos")]
    {
        clipboard_files_macos()
    }
    #[cfg(target_os = "linux")]
    {
        clipboard_files_linux()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("当前平台不支持从剪贴板粘贴文件".to_string())
    }
}

/// Windows：CF_HDROP 就是资源管理器复制文件时写的格式，拖放与它是同一套句柄。
#[cfg(target_os = "windows")]
fn clipboard_files_windows() -> Result<Vec<String>, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    use windows_sys::Win32::System::Ole::CF_HDROP;
    use windows_sys::Win32::UI::Shell::{DragQueryFileW, HDROP};

    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP as u32) == 0 {
            return Ok(Vec::new());
        }
        // 剪贴板同一时间只能被一个进程打开；被占用时短暂重试，仍失败就如实报错。
        let mut opened = 0;
        for _ in 0..5 {
            opened = OpenClipboard(std::ptr::null_mut());
            if opened != 0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        if opened == 0 {
            return Err("剪贴板被其他程序占用，请稍后再试".to_string());
        }

        let mut files = Vec::new();
        let handle = GetClipboardData(CF_HDROP as u32);
        if !handle.is_null() {
            // CF_HDROP 的数据是 HGLOBAL，要 GlobalLock 才能当 HDROP 用；解引用的是剪贴板内存，
            // 只能用 DragQueryFileW 取名字，不能 free。
            let drop = GlobalLock(handle) as HDROP;
            if !drop.is_null() {
                // ifile = 0xFFFFFFFF 表示"返回文件个数"。
                let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
                for i in 0..count {
                    let len = DragQueryFileW(drop, i, std::ptr::null_mut(), 0) as usize;
                    if len == 0 {
                        continue;
                    }
                    let mut buf = vec![0u16; len + 1];
                    let n = DragQueryFileW(drop, i, buf.as_mut_ptr(), buf.len() as u32) as usize;
                    buf.truncate(n);
                    files.push(OsString::from_wide(&buf).to_string_lossy().into_owned());
                }
                GlobalUnlock(handle);
            }
        }
        CloseClipboard();
        Ok(files)
    }
}

/// macOS：Finder 复制文件时剪贴板里是 furl（file URL）列表，用 AppleScript 取，
/// 免引第三方剪贴板依赖。剪贴板不是文件时脚本输出为空，按"没有文件"处理。
#[cfg(target_os = "macos")]
fn clipboard_files_macos() -> Result<Vec<String>, String> {
    const SCRIPT: &str = r#"
set out to ""
try
	set theFiles to the clipboard as {«class furl»}
	repeat with f in theFiles
		set out to out & (POSIX path of f) & linefeed
	end repeat
end try
return out
"#;
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(SCRIPT)
        .output()
        .map_err(|e| format!("调用 osascript 失败：{e}"))?;
    if !out.status.success() {
        return Err("读剪贴板失败：剪贴板里的内容不是文件".to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

/// Linux：文件管理器把复制项写成 `text/uri-list`，优先 wl-paste（Wayland），回退 xclip（X11）。
#[cfg(target_os = "linux")]
fn clipboard_files_linux() -> Result<Vec<String>, String> {
    let attempts: [(&str, &[&str]); 2] = [
        ("wl-paste", &["--no-newline", "--type", "text/uri-list"]),
        (
            "xclip",
            &["-selection", "clipboard", "-t", "text/uri-list", "-o"],
        ),
    ];
    for (cmd, args) in attempts {
        if let Ok(out) = std::process::Command::new(cmd).args(args).output() {
            if out.status.success() {
                return Ok(parse_uri_list(&String::from_utf8_lossy(&out.stdout)));
            }
        }
    }
    Err("读剪贴板需要 wl-paste 或 xclip，当前都不可用".to_string())
}

/// 解析 `text/uri-list`：只取 `file://` 行，去掉 host 段并做百分号解码。
#[cfg(target_os = "linux")]
fn parse_uri_list(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter_map(|line| line.strip_prefix("file://"))
        .filter_map(|rest| {
            // `file:///home/a b.jpg` 的 host 段为空；`file://host/path` 要去掉 host。
            let path = match rest.strip_prefix('/') {
                Some(_) => rest.to_string(),
                None => rest[rest.find('/')?..].to_string(),
            };
            percent_decode(&path)
        })
        .collect()
}

#[cfg(target_os = "linux")]
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 是否以管理员身份运行。Windows 上管理员进程收不到 Explorer 的 OLE 拖放（R13），
/// 前端据此提示改用「打开文件」；其他平台恒为 false。
#[tauri::command]
fn albumio_elevated() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::ffi::c_void;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::Security::{
            GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

        unsafe {
            let mut token = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut returned = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut elevation as *mut TOKEN_ELEVATION as *mut c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            );
            CloseHandle(token);
            ok != 0 && elevation.TokenIsElevated != 0
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
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
        // 单实例必须最先注册：第二进程在其余插件与 setup 之前就被拦下并退出（M9）。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // 第二进程已由插件接管：这里只把目标交给主窗口，并把它叫到前台。
            let target = target_from_args(&argv);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            if let Some(path) = target {
                if let Some(slot) = app.try_state::<PendingTarget>() {
                    if let Ok(mut pending) = slot.0.lock() {
                        *pending = Some(path.clone());
                    }
                }
                let _ = app.emit("albumio://open-target", path);
            }
        }))
        .setup(|app| {
            let dir = data_dir(app.handle())?;
            let pipeline = Pipeline::new(dir.join("thumbs"))
                .map_err(|e| io::Error::other(format!("缩略图缓存初始化失败：{e}")))?;
            let _ = pipeline.sweep();
            // M9：第一个参数可以是目录（`albumio <dir>`）或文件（默认打开方式）。
            let start = std::env::args().nth(1);
            let index = match Index::open(dir.join("index.db")) {
                Ok(idx) => Some(idx),
                Err(e) => {
                    eprintln!("[index] 打不开（将按无索引运行）：{e}");
                    None
                }
            };
            app.manage(DataDir(dir));
            app.manage(StartTarget(start));
            app.manage(PendingTarget(Mutex::new(None)));
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
            albumio_launch_target,
            albumio_resolve_target,
            albumio_take_pending,
            albumio_clipboard_files,
            albumio_elevated,
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
