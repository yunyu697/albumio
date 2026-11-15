//! 目录监听与增量索引（04-项目计划 M8）。
//!
//! 方案与参数取自 `docs/spike/S6.md` 的实测：
//! - 只监听当前目录（不递归），事件消费在独立线程；
//! - 静止窗口 **300 ms** 合并，最长 **1200 ms** 必须吐一批；
//! - Windows 的改名是相邻 `From` / `To`，`notify` 不暴露 cookie，按到达顺序配对；
//! - 批次内按路径去重，最终增删以 `stat` 为准（覆盖保存、原子替换都靠它）；
//! - 通道报错或 `Rescan` 标志 → 本批只报 `overflow`，由前端整目录重建。

use crate::listing::has_image_ext;
use notify::event::{ModifyKind, RenameMode};
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

pub const QUIET_MS: u64 = 300;
pub const MAX_MS: u64 = 1200;

/// 单批最多攒这么多条原始事件；超过说明消费者已经跟不上，直接走整目录重建
/// （`docs/spike/S6.md` §4：一条事件 150–250 B，5 万条约 10 MB，不能再涨）。
const BACKLOG_LIMIT: usize = 50_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Debounce {
    pub quiet: Duration,
    pub max: Duration,
}

impl Default for Debounce {
    fn default() -> Self {
        Self {
            quiet: Duration::from_millis(QUIET_MS),
            max: Duration::from_millis(MAX_MS),
        }
    }
}

/// 一条新增/内容变更；尺寸与 mtime 已按批次末尾的 stat 校正。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mtime_ns: i128,
}

/// 改名提示：前端用它迁移选中/评分；增删仍以 `upserts` / `removed` 为准。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchRename {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirChanges {
    pub dir: String,
    pub upserts: Vec<WatchEntry>,
    pub removed: Vec<String>,
    pub renamed: Vec<WatchRename>,
    /// 监听通道报错 / 溢出；前端应整目录重建而不是应用本批增量。
    pub overflow: bool,
}

impl DirChanges {
    pub fn is_empty(&self) -> bool {
        self.upserts.is_empty()
            && self.removed.is_empty()
            && self.renamed.is_empty()
            && !self.overflow
    }
}

/// 还原后的原始事件（`notify::Event` 只在这里出现一次，便于单测）。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Raw {
    Path(PathBuf),
    From(PathBuf),
    To(PathBuf),
    Error,
}

fn from_event(ev: Event) -> Vec<Raw> {
    // macOS FSEvents 的 Rescan 表示「此前事件不可信」，与通道报错同样降级。
    if ev.need_rescan() {
        return vec![Raw::Error];
    }
    match ev.kind {
        EventKind::Modify(ModifyKind::Name(mode)) => match mode {
            RenameMode::Both => {
                let mut out = Vec::new();
                if let Some(from) = ev.paths.first() {
                    out.push(Raw::From(from.clone()));
                }
                if let Some(to) = ev.paths.get(1) {
                    out.push(Raw::To(to.clone()));
                }
                out
            }
            RenameMode::From => ev
                .paths
                .first()
                .cloned()
                .map(Raw::From)
                .into_iter()
                .collect(),
            RenameMode::To => ev.paths.first().cloned().map(Raw::To).into_iter().collect(),
            _ => ev.paths.into_iter().map(Raw::Path).collect(),
        },
        // 打开/读取也会产生 Access，网格不关心。
        EventKind::Access(_) => Vec::new(),
        _ => ev.paths.into_iter().map(Raw::Path).collect(),
    }
}

/// 下载中转、Office 锁文件、系统缩略图库都不进批次。
fn ignored_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("~$") || lower == "thumbs.db" || lower == "desktop.ini" {
        return true;
    }
    match lower.rsplit_once('.') {
        Some((_, ext)) => matches!(ext, "tmp" | "part" | "crdownload"),
        None => false,
    }
}

fn relevant(path: &Path) -> bool {
    match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => !ignored_name(name) && has_image_ext(name),
        None => false,
    }
}

/// 把一批原始事件落成前端可直接应用的增量。
fn build_batch(dir: &Path, raws: &[Raw]) -> DirChanges {
    let mut out = DirChanges {
        dir: dir.display().to_string(),
        ..Default::default()
    };
    let mut touched: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut renames: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut pending: Option<PathBuf> = None;
    let mut overflow = false;

    fn touch(p: &Path, touched: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>) {
        if seen.insert(p.to_path_buf()) {
            touched.push(p.to_path_buf());
        }
    }

    for raw in raws {
        match raw {
            Raw::Path(p) => {
                if relevant(p) {
                    touch(p, &mut touched, &mut seen);
                }
            }
            // From 只有后面跟着 To 才有意义；不相关的 From 不能清掉待配对项。
            Raw::From(p) => {
                if relevant(p) {
                    pending = Some(p.clone());
                }
            }
            Raw::To(p) => {
                if !relevant(p) {
                    pending = None;
                    continue;
                }
                match pending.take() {
                    Some(from) if from != *p => {
                        renames.push((from.clone(), p.clone()));
                        touch(&from, &mut touched, &mut seen);
                        touch(p, &mut touched, &mut seen);
                    }
                    _ => touch(p, &mut touched, &mut seen),
                }
            }
            Raw::Error => overflow = true,
        }
    }
    // 批次结束时还挂着的 From = 文件移出当前目录。
    if let Some(from) = pending {
        touch(&from, &mut touched, &mut seen);
    }

    if overflow {
        out.overflow = true;
        return out;
    }

    for p in &touched {
        match std::fs::metadata(p) {
            Ok(meta) if meta.is_file() => {
                let name = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_string();
                out.upserts.push(WatchEntry {
                    path: p.display().to_string(),
                    name,
                    size: meta.len(),
                    mtime_ns: crate::cache::mtime_ns(&meta),
                });
            }
            _ => out.removed.push(p.display().to_string()),
        }
    }

    // 只有新路径确实还在的配对才算改名；否则按删除处理（配对只做迁移提示）。
    let alive: HashSet<&str> = out.upserts.iter().map(|e| e.path.as_str()).collect();
    out.renamed = renames
        .into_iter()
        .filter_map(|(from, to)| {
            let to_s = to.display().to_string();
            if alive.contains(to_s.as_str()) {
                Some(WatchRename {
                    from: from.display().to_string(),
                    to: to_s,
                })
            } else {
                None
            }
        })
        .collect();

    out
}

/// 活动中的目录监听。`Drop` 会停线程；换目录时先 `stop()` 再 `start()`。
pub struct DirWatcher {
    dir: PathBuf,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl DirWatcher {
    /// 监听 `dir` 的非递归变更；每批增量在后台线程里回调，回调里不要做重活。
    pub fn start(
        dir: impl AsRef<Path>,
        cfg: Debounce,
        mut emit: impl FnMut(DirChanges) + Send + 'static,
    ) -> crate::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        let (tx, rx) = channel::<Raw>();
        let mut watcher = RecommendedWatcher::new(
            move |res: notify::Result<Event>| {
                let raws = match res {
                    Ok(ev) => from_event(ev),
                    Err(_) => vec![Raw::Error],
                };
                for raw in raws {
                    let _ = tx.send(raw);
                }
            },
            Config::default(),
        )
        .map_err(|e| crate::Error::Invalid(format!("创建目录监听失败：{e}")))?;
        watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .map_err(|e| crate::Error::Invalid(format!("监听目录失败：{e}")))?;

        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = stop.clone();
        let dir_thread = dir.clone();
        let handle = thread::spawn(move || {
            // watcher 必须活在消费线程里，drop 即停止监听。
            let _keep_alive = watcher;
            run_loop(&dir_thread, cfg, &stop_thread, &rx, &mut emit);
        });
        Ok(Self {
            dir,
            stop,
            handle: Some(handle),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn stop(mut self) {
        self.stop_and_join();
    }

    fn stop_and_join(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for DirWatcher {
    fn drop(&mut self) {
        self.stop_and_join();
    }
}

fn run_loop(
    dir: &Path,
    cfg: Debounce,
    stop: &AtomicBool,
    rx: &Receiver<Raw>,
    emit: &mut impl FnMut(DirChanges),
) {
    // 50 ms 的轮询粒度：既能及时响应 stop，也不至于空转。
    let poll = Duration::from_millis(50);
    let mut pending: Vec<Raw> = Vec::new();
    let mut first_at: Option<Instant> = None;
    let mut last_at = Instant::now();

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let wait = if pending.is_empty() {
            poll
        } else {
            let quiet_left = cfg.quiet.saturating_sub(last_at.elapsed());
            let max_left = cfg
                .max
                .saturating_sub(first_at.map(|t| t.elapsed()).unwrap_or_default());
            quiet_left.min(max_left).min(poll)
        };

        match rx.recv_timeout(wait) {
            Ok(raw) => {
                if pending.is_empty() {
                    first_at = Some(Instant::now());
                }
                last_at = Instant::now();
                pending.push(raw);
                if pending.len() > BACKLOG_LIMIT {
                    pending.clear();
                    pending.push(Raw::Error);
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                let quiet_done = last_at.elapsed() >= cfg.quiet;
                let hard_done = first_at.map(|t| t.elapsed() >= cfg.max).unwrap_or(true);
                if !pending.is_empty() && (quiet_done || hard_done) {
                    let changes = build_batch(dir, &pending);
                    pending.clear();
                    first_at = None;
                    if !changes.is_empty() {
                        emit(changes);
                    }
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    if !pending.is_empty() {
        let changes = build_batch(dir, &pending);
        if !changes.is_empty() {
            emit(changes);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn abs(p: &Path) -> String {
        p.display().to_string()
    }

    #[test]
    fn rename_pair_reports_one_rename_and_stat_corrected_add_remove() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.jpg");
        let b = dir.path().join("b.jpg");
        fs::write(&a, b"x").unwrap();
        fs::rename(&a, &b).unwrap();

        let changes = build_batch(dir.path(), &[Raw::From(a.clone()), Raw::To(b.clone())]);
        assert!(!changes.overflow);
        assert_eq!(
            changes.renamed,
            vec![WatchRename {
                from: abs(&a),
                to: abs(&b)
            }]
        );
        assert!(changes
            .upserts
            .iter()
            .any(|e| e.path == abs(&b) && e.name == "b.jpg"));
        assert!(changes.removed.contains(&abs(&a)));
    }

    #[test]
    fn atomic_replace_keeps_target_without_remove() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a.jpg");
        let tmp = dir.path().join(".a.jpg.tmp");
        fs::write(&tmp, b"y").unwrap();
        fs::rename(&tmp, &target).unwrap();

        // Windows 上会先报旧目标 Remove，再报 .tmp 的 From/To。
        let changes = build_batch(
            dir.path(),
            &[
                Raw::Path(target.clone()),
                Raw::From(tmp.clone()),
                Raw::To(target.clone()),
            ],
        );
        assert!(changes.upserts.iter().any(|e| e.path == abs(&target)));
        assert!(changes.removed.is_empty(), "覆盖式保存不应把目标报成删除");
        assert!(changes.renamed.is_empty(), "中转文件不进改名清单");
    }

    #[test]
    fn temp_and_non_image_paths_are_dropped() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"x").unwrap();
        fs::write(dir.path().join("a.jpg.part"), b"x").unwrap();
        fs::write(dir.path().join("~$doc.jpg"), b"x").unwrap();

        let changes = build_batch(
            dir.path(),
            &[
                Raw::Path(dir.path().join("a.txt")),
                Raw::Path(dir.path().join("a.jpg.part")),
                Raw::Path(dir.path().join("~$doc.jpg")),
            ],
        );
        assert!(changes.is_empty());
    }

    #[test]
    fn error_without_changes_reports_overflow() {
        let dir = tempfile::tempdir().unwrap();
        let changes = build_batch(dir.path(), &[Raw::Error]);
        assert!(changes.overflow);
        assert!(changes.upserts.is_empty());
        assert!(changes.removed.is_empty());
    }
}
