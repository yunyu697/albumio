//! 目录列举与分批 stat（04-项目计划 M2）。
//!
//! 两条硬约束来自 `docs/spike/S4.md` 的实测（1 万文件：readdir 5.6ms，全量 stat 835ms）：
//! 1. **readdir 与 stat 分离**：先拿名字出格子占位，再按优先级分批补大小/mtime；
//! 2. **P0–P4 五级队列 + generation 取消**：换目录时旧任务整批丢弃，不允许回跳覆盖新目录。
//!
//! 优先级语义（`04-项目计划.md` §3 M2）：
//! - P0 可见区、P1 预取、P2 当前目录、P3 相邻目录、P4 全库（默认关）。

use crate::cache::mtime_ns;
use crate::Result;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// 网格认的图片扩展名。不含 HEIC/RAW 的可见性差异：这些格式能否解码由管线决定，
/// 列举阶段只按扩展名收进来，解码失败会在缩略图上显式报错，而不是悄悄消失。
/// RAW 部分必须和 `probe::RAW_EXTS` 对齐，否则会出现「能解码但列不出来」。
pub const IMAGE_EXTS: &[&str] = &[
    "jpg", "jpeg", "png", "tif", "tiff", "bmp", "webp", "gif", "heic", "heif", "avif", "dng",
    "arw", "cr2", "cr3", "crw", "nef", "nrw", "raf", "rw2", "raw", "orf", "pef", "rwl", "srw",
    "srf", "sr2", "x3f", "3fr", "fff", "iiq", "mos", "mrw", "kdc", "mef", "erf",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryStat {
    pub path: String,
    pub size: u64,
    pub mtime_ns: i128,
}

/// 只做 readdir：读名字 + 用 `DirEntry::file_type` 区分目录，不 stat 任何文件。
pub fn read_entries(dir: &Path) -> Result<Vec<ListEntry>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // 列举期间被删掉的条目直接跳过，不让整次列举失败
        };
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        out.push(ListEntry {
            path: entry.path().display().to_string(),
            name,
            is_dir: file_type.is_dir(),
        });
    }
    out.sort_by(|a, b| natural_cmp(&a.name, &b.name));
    Ok(out)
}

/// 网格只显示图片文件；目录由 M3 的侧栏树承担。
pub fn read_images(dir: &Path) -> Result<Vec<ListEntry>> {
    let mut entries = read_entries(dir)?;
    entries.retain(|e| !e.is_dir && has_image_ext(&e.name));
    Ok(entries)
}

pub fn has_image_ext(name: &str) -> bool {
    match name.rsplit_once('.') {
        Some((_, ext)) => IMAGE_EXTS.iter().any(|e| ext.eq_ignore_ascii_case(e)),
        None => false,
    }
}

/// 文件名的自然序：数字段按数值比较（DSC_2 在 DSC_10 前），其余按小写字典序。
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    // 两侧都按「相对整串的绝对字节偏移」推进：比较器一旦混用切片内相对偏移，
    // 数字段之后取到的字符就会错位，并且偏移不再前进，排序会陷入死循环。
    let (mut i, mut j) = (0usize, 0usize);
    loop {
        match (a[i..].chars().next(), b[j..].chars().next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ac), Some(bc)) => {
                if ac.is_ascii_digit() && bc.is_ascii_digit() {
                    let (an, anext) = take_digits(a, i);
                    let (bn, bnext) = take_digits(b, j);
                    let ord = an.cmp(&bn);
                    if ord != Ordering::Equal {
                        return ord;
                    }
                    // 数字段等值也必须各前进至少一个字符，否则比较器不收敛。
                    i = anext;
                    j = bnext;
                } else {
                    let al = ac.to_ascii_lowercase();
                    let bl = bc.to_ascii_lowercase();
                    if al != bl {
                        return al.cmp(&bl);
                    }
                    i += ac.len_utf8();
                    j += bc.len_utf8();
                }
            }
        }
    }
}

/// 从字节位置开始取一段连续数字，返回（数值，结束字节位置）。
fn take_digits(s: &str, start: usize) -> (u128, usize) {
    let mut end = start;
    for (i, c) in s[start..].char_indices() {
        if c.is_ascii_digit() {
            end = start + i + c.len_utf8();
        } else {
            break;
        }
    }
    (s[start..end].parse::<u128>().unwrap_or(0), end)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    P0,
    P1,
    P2,
    P3,
    P4,
}

impl Priority {
    pub fn from_u8(v: u8) -> Option<Priority> {
        match v {
            0 => Some(Priority::P0),
            1 => Some(Priority::P1),
            2 => Some(Priority::P2),
            3 => Some(Priority::P3),
            4 => Some(Priority::P4),
            _ => None,
        }
    }

    pub fn index(self) -> usize {
        self as usize
    }
}

#[derive(Debug, Clone)]
struct Job {
    path: PathBuf,
    generation: u64,
}

/// 五条独立的 FIFO：同级先到先服务，跨级永远 P0 先出。
#[derive(Default)]
struct PriorityQueue {
    lanes: [VecDeque<Job>; 5],
}

impl PriorityQueue {
    fn new() -> Self {
        Self {
            lanes: Default::default(),
        }
    }

    fn push(&mut self, priority: Priority, job: Job) {
        self.lanes[priority.index()].push_back(job);
    }

    fn pop(&mut self) -> Option<Job> {
        for lane in self.lanes.iter_mut() {
            if let Some(job) = lane.pop_front() {
                return Some(job);
            }
        }
        None
    }

    fn retain_generation(&mut self, generation: u64) {
        for lane in self.lanes.iter_mut() {
            lane.retain(|j| j.generation == generation);
        }
    }

    fn len(&self) -> usize {
        self.lanes.iter().map(|l| l.len()).sum()
    }
}

/// 进程内列举状态：当前 generation + 待 stat 队列。
pub struct Listing {
    generation: AtomicU64,
    queue: Mutex<PriorityQueue>,
}

#[derive(Debug)]
pub struct StatOutcome {
    pub stats: Vec<EntryStat>,
    pub cancelled: bool,
}

impl Default for Listing {
    fn default() -> Self {
        Self::new()
    }
}

impl Listing {
    pub fn new() -> Self {
        Self {
            generation: AtomicU64::new(1),
            queue: Mutex::new(PriorityQueue::new()),
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// 换目录：generation +1，旧 generation 的排队任务立即丢弃。
    pub fn begin_generation(&self) -> u64 {
        let next = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.queue
            .lock()
            .expect("listing queue poisoned")
            .retain_generation(next);
        next
    }

    pub fn enqueue(&self, paths: &[String], priority: Priority, generation: u64) {
        let mut q = self.queue.lock().expect("listing queue poisoned");
        for p in paths {
            q.push(
                priority,
                Job {
                    path: PathBuf::from(p),
                    generation,
                },
            );
        }
    }

    /// 按优先级取出并 stat，最多 `limit` 个。generation 变了就停手并标记 cancelled。
    pub fn drain(&self, limit: usize) -> StatOutcome {
        let current = self.generation();
        let mut stats = Vec::new();
        let mut cancelled = false;
        for _ in 0..limit {
            let job = {
                let mut q = self.queue.lock().expect("listing queue poisoned");
                q.pop()
            };
            let Some(job) = job else { break };
            if job.generation != current || self.generation() != current {
                cancelled = true;
                continue;
            }
            match std::fs::metadata(&job.path) {
                Ok(m) => stats.push(EntryStat {
                    path: job.path.display().to_string(),
                    size: m.len(),
                    mtime_ns: mtime_ns(&m),
                }),
                // 列举与 stat 之间被删掉：跳过，不让整批失败。
                Err(_) => {}
            }
        }
        if self.generation() != current {
            cancelled = true;
        }
        StatOutcome { stats, cancelled }
    }

    pub fn pending(&self) -> usize {
        self.queue.lock().expect("listing queue poisoned").len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    /// 列举扩展名必须覆盖 probe 认的全部 RAW 扩展名，否则会出现
    /// 「管线能解、网格里却看不到」的静默缺失。
    #[test]
    fn listing_covers_every_raw_extension() {
        for ext in crate::probe::RAW_EXTS {
            assert!(IMAGE_EXTS.contains(ext), "IMAGE_EXTS 缺少 RAW 扩展名 {ext}");
        }
    }

    #[test]
    fn read_images_filters_and_sorts_naturally() {
        let dir = make_dir();
        for name in ["DSC_10.JPG", "DSC_2.JPG", "notes.txt", "cover.png"] {
            fs::write(dir.path().join(name), b"x").unwrap();
        }
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("sub/inner.jpg"), b"x").unwrap();

        let names: Vec<_> = read_images(dir.path())
            .unwrap()
            .into_iter()
            .map(|e| e.name)
            .collect();
        assert_eq!(names, vec!["cover.png", "DSC_2.JPG", "DSC_10.JPG"]);
    }

    /// 回归：比较器曾混用切片内相对偏移与整串绝对偏移，数字段之后偏移不再前进，
    /// 排序永不返回，整个进程在主线程自旋（RC5 Windows 启动卡死的根因）。
    /// 这类「共同前缀 + 两段数字」的文件名（截图/相机导出）在真实目录里极常见。
    #[test]
    fn natural_cmp_terminates_on_two_digit_runs() {
        let names = [
            "Snipaste_2025-03-20_21-28-43.png",
            "Snipaste_2025-03-09_12-51-25.png",
            "Snipaste_2025-03-09_12-45-53.png",
        ];
        let mut v: Vec<&str> = names.to_vec();
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            v,
            vec![
                "Snipaste_2025-03-09_12-45-53.png",
                "Snipaste_2025-03-09_12-51-25.png",
                "Snipaste_2025-03-20_21-28-43.png",
            ]
        );
        // 前导零：数值相等但位数不同，也必须收敛。
        assert_eq!(
            natural_cmp("IMG_01.png", "IMG_1.png"),
            std::cmp::Ordering::Equal
        );
    }

    #[test]
    fn queue_serves_p0_first_and_fifo_within_lane() {
        let dir = make_dir();
        let enqueue = |listing: &Listing, name: &str, p: Priority| {
            let path = dir.path().join(name);
            fs::write(&path, b"x").unwrap();
            listing.enqueue(&vec![path.display().to_string()], p, listing.generation());
        };

        let listing = Listing::new();
        enqueue(&listing, "p3.jpg", Priority::P3);
        enqueue(&listing, "p0a.jpg", Priority::P0);
        enqueue(&listing, "p2.jpg", Priority::P2);
        enqueue(&listing, "p0b.jpg", Priority::P0);
        assert_eq!(listing.pending(), 4);

        let out = listing.drain(4);
        assert!(!out.cancelled);
        let order: Vec<_> = out
            .stats
            .iter()
            .map(|s| {
                Path::new(&s.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        assert_eq!(order, vec!["p0a.jpg", "p0b.jpg", "p2.jpg", "p3.jpg"]);
    }

    #[test]
    fn new_generation_drops_pending_jobs() {
        let listing = Listing::new();
        let gen = listing.generation();
        listing.enqueue(&vec!["a".into(), "b".into()], Priority::P2, gen);
        let next = listing.begin_generation();
        assert_ne!(gen, next);
        let out = listing.drain(10);
        assert!(out.stats.is_empty());
        assert_eq!(listing.pending(), 0);
    }

    #[test]
    fn drain_stops_at_limit_and_reports_completion() {
        let dir = make_dir();
        let names: Vec<String> = (0..10)
            .map(|i| {
                let n = format!("f{i}.jpg");
                fs::write(dir.path().join(&n), b"x").unwrap();
                dir.path().join(&n).display().to_string()
            })
            .collect();

        let listing = Listing::new();
        let gen = listing.generation();
        listing.enqueue(&names, Priority::P0, gen);
        let first = listing.drain(3);
        assert_eq!(first.stats.len(), 3);
        assert!(!first.cancelled);
        let rest = listing.drain(10);
        assert_eq!(rest.stats.len(), 7);
        assert_eq!(listing.pending(), 0);
    }

    #[test]
    fn stat_carries_size_and_mtime() {
        let dir = make_dir();
        let path = dir.path().join("one.jpg");
        fs::write(&path, b"12345").unwrap();
        let listing = Listing::new();
        listing.enqueue(
            &vec![path.display().to_string()],
            Priority::P0,
            listing.generation(),
        );
        let out = listing.drain(1);
        assert_eq!(out.stats[0].size, 5);
        assert!(out.stats[0].mtime_ns > 0);
    }

    #[test]
    fn missing_file_is_skipped_not_fatal() {
        let listing = Listing::new();
        listing.enqueue(
            &vec![std::env::temp_dir()
                .join("albumio-does-not-exist.jpg")
                .display()
                .to_string()],
            Priority::P0,
            listing.generation(),
        );
        let out = listing.drain(1);
        assert!(out.stats.is_empty());
        assert!(!out.cancelled);
    }
}
