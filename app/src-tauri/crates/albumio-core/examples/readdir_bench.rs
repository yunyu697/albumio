//! S4 先行验证的可复跑最小代码（`docs/spike/S4.md`）。
//!
//! 用法：`cargo run --release --example readdir_bench -- <目录>`。
//! 分别测量三件事，各跑 5 轮取中位数：
//!   1. readdir 只取名字（不做 metadata）；
//!   2. readdir + `DirEntry::file_type`（判断目录用，仍不 stat 具体文件）；
//!   3. 对全部文件条目逐个 `fs::metadata`（stat 全量）。
//!
//! 三者之差就是"readdir 与 stat 必须分离"的量化依据。

use std::path::PathBuf;
use std::time::{Duration, Instant};

fn median(mut v: Vec<Duration>) -> Duration {
    v.sort();
    v[v.len() / 2]
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .expect("用法：readdir_bench <目录>");
    let rounds = 5;

    let mut names = Vec::new();
    let mut types = Vec::new();
    let mut stats = Vec::new();
    let mut bytes = 0u64;
    let mut count = 0usize;

    for _ in 0..rounds {
        let t0 = Instant::now();
        let mut n = 0usize;
        for e in std::fs::read_dir(&dir).expect("read_dir 失败") {
            let e = e.expect("条目读取失败");
            let _ = e.file_name();
            n += 1;
        }
        count = n;
        names.push(t0.elapsed());

        let t0 = Instant::now();
        let mut files = Vec::new();
        for e in std::fs::read_dir(&dir).expect("read_dir 失败") {
            let e = e.expect("条目读取失败");
            let ft = e.file_type().expect("file_type 失败");
            if ft.is_file() {
                files.push(e.path());
            }
        }
        types.push(t0.elapsed());

        let t0 = Instant::now();
        bytes = 0;
        for p in &files {
            if let Ok(m) = std::fs::metadata(p) {
                bytes += m.len();
            }
        }
        stats.push(t0.elapsed());
    }

    println!("目录：{}", dir.display());
    println!("条目数：{count}（文件字节合计 {bytes}）");
    println!("readdir 仅名字：{:?}", median(names));
    println!("readdir + file_type：{:?}", median(types));
    println!("readdir + 全量 stat：{:?}", median(stats));
}
