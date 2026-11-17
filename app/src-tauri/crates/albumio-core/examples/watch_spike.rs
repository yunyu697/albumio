//! S6 spike：notify 8 在 Windows 上的事件序列 / 去抖 / 改名配对 / 溢出降级。
//!
//! 用法（在 `app/src-tauri` 下）：
//!   cargo run --release -p albumio-core --example watch_spike -- events  "%TEMP%\albumio-s6"
//!   cargo run --release -p albumio-core --example watch_spike -- burst   "%TEMP%\albumio-s6" 1000
//!   cargo run --release -p albumio-core --example watch_spike -- overflow "%TEMP%\albumio-s6" 6000 3000
//!
//! 输出直接用于 `app/docs/spike/S6.md` 的实测表；每次运行都会重建自己的子目录。

use notify::event::ModifyKind;
use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::channel;
use std::thread;
use std::time::{Duration, Instant};

struct Rec {
    at: Duration,
    res: Result<Event, notify::Error>,
}

fn short(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).display().to_string()
}

fn ms(d: Duration) -> String {
    format!("{:.1}", d.as_secs_f64() * 1000.0)
}

fn start(
    root: &Path,
    dir: &Path,
    t0: Instant,
    block: Duration,
    verbose: bool,
) -> (RecommendedWatcher, thread::JoinHandle<Vec<Rec>>) {
    let (tx, rx) = channel::<Result<Event, notify::Error>>();
    let mut w = RecommendedWatcher::new(
        move |res| {
            let _ = tx.send(res);
        },
        Config::default(),
    )
    .expect("create watcher");
    w.watch(dir, RecursiveMode::NonRecursive).expect("watch");

    let root = root.to_path_buf();
    let h = thread::spawn(move || {
        // 模拟"主线程正在解码/渲染，事件消费者被占住"
        if !block.is_zero() {
            thread::sleep(block);
        }
        let mut out = Vec::new();
        while let Ok(res) = rx.recv() {
            let at = t0.elapsed();
            if verbose {
                match &res {
                    Ok(ev) => {
                        let paths: Vec<String> = ev.paths.iter().map(|p| short(&root, p)).collect();
                        println!(
                            "  +{:>9}ms  {:?}  [{}]",
                            ms(at),
                            ev.kind,
                            paths.join(" -> ")
                        );
                    }
                    Err(e) => println!("  +{:>9}ms  ERROR {:?}  {}", ms(at), e.kind, e),
                }
            }
            out.push(Rec { at, res });
        }
        out
    });
    (w, h)
}

fn finish(w: RecommendedWatcher, h: thread::JoinHandle<Vec<Rec>>) -> Vec<Rec> {
    drop(w);
    h.join().expect("consumer thread")
}

fn bucket(ev: &Event) -> &'static str {
    match ev.kind {
        EventKind::Create(_) => "create",
        EventKind::Modify(ModifyKind::Name(_)) => "rename",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        EventKind::Access(_) => "access",
        _ => "other",
    }
}

fn summarize(label: &str, recs: &[Rec]) {
    let mut create = 0;
    let mut rename = 0;
    let mut modify = 0;
    let mut remove = 0;
    let mut other = 0;
    let mut errors = 0;
    let mut distinct = std::collections::HashSet::new();
    let mut both = 0;
    for r in recs {
        match &r.res {
            Ok(ev) => {
                for p in &ev.paths {
                    distinct.insert(p.clone());
                }
                match bucket(ev) {
                    "create" => create += 1,
                    "rename" => {
                        rename += 1;
                        if matches!(
                            ev.kind,
                            EventKind::Modify(ModifyKind::Name(notify::event::RenameMode::Both))
                        ) {
                            both += 1;
                        }
                    }
                    "modify" => modify += 1,
                    "remove" => remove += 1,
                    _ => other += 1,
                }
            }
            Err(_) => errors += 1,
        }
    }
    println!(
        "\n[{}] 事件 {}（create {} / rename {}（Both {}）/ modify {} / remove {} / other {}），错误 {}，涉及路径 {}",
        label,
        recs.len(), create, rename, both, modify, remove, other, errors, distinct.len()
    );
    if let (Some(first), Some(last)) = (recs.first(), recs.last()) {
        let mut max_gap = Duration::ZERO;
        for w in recs.windows(2) {
            let g = w[1].at.saturating_sub(w[0].at);
            if g > max_gap {
                max_gap = g;
            }
        }
        println!(
            "[{}] 首事件 +{}ms，末事件 +{}ms，跨度 {}ms，最大事件间隔 {}ms",
            label,
            ms(first.at),
            ms(last.at),
            ms(last.at.saturating_sub(first.at)),
            ms(max_gap)
        );
    }
}

fn step(s: &str) {
    println!("\n=== {} ===", s);
}

fn scenario_events(root: &Path) {
    let dir = root.join("events");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("sub")).unwrap();

    let t0 = Instant::now();
    let (w, h) = start(root, &dir, t0, Duration::ZERO, true);
    thread::sleep(Duration::from_millis(300));

    step("新建 a.jpg（1 B）");
    fs::write(dir.join("a.jpg"), b"x").unwrap();
    thread::sleep(Duration::from_millis(300));

    step("向 a.jpg 追加 4×4 KB");
    {
        let mut f = OpenOptions::new()
            .append(true)
            .open(dir.join("a.jpg"))
            .unwrap();
        for _ in 0..4 {
            f.write_all(&[7u8; 4096]).unwrap();
            f.flush().unwrap();
        }
    }
    thread::sleep(Duration::from_millis(300));

    step("原子替换：写 .a.jpg.tmp 再 rename 覆盖 a.jpg");
    fs::write(dir.join(".a.jpg.tmp"), b"y").unwrap();
    fs::rename(dir.join(".a.jpg.tmp"), dir.join("a.jpg")).unwrap();
    thread::sleep(Duration::from_millis(300));

    step("原路径重写 a.jpg（truncate 覆盖）");
    fs::write(dir.join("a.jpg"), b"zz").unwrap();
    thread::sleep(Duration::from_millis(300));

    step("改名 a.jpg -> b.jpg");
    fs::rename(dir.join("a.jpg"), dir.join("b.jpg")).unwrap();
    thread::sleep(Duration::from_millis(300));

    step("移入子目录 b.jpg -> sub/b.jpg");
    fs::rename(dir.join("b.jpg"), dir.join("sub").join("b.jpg")).unwrap();
    thread::sleep(Duration::from_millis(300));

    step("移回 sub/b.jpg -> b.jpg");
    fs::rename(dir.join("sub").join("b.jpg"), dir.join("b.jpg")).unwrap();
    thread::sleep(Duration::from_millis(300));

    step("删除 b.jpg");
    fs::remove_file(dir.join("b.jpg")).unwrap();
    thread::sleep(Duration::from_millis(300));

    step("慢写 slow.jpg：64 × 32 KB，每块间隔 40 ms");
    {
        let mut f = fs::File::create(dir.join("slow.jpg")).unwrap();
        for _ in 0..64 {
            f.write_all(&[3u8; 32 * 1024]).unwrap();
            f.flush().unwrap();
            thread::sleep(Duration::from_millis(40));
        }
    }
    thread::sleep(Duration::from_millis(600));

    step("先建 r1/r2/r3，再连续改名 r1->s1, r2->s2, r3->s3");
    for n in ["r1.jpg", "r2.jpg", "r3.jpg"] {
        fs::write(dir.join(n), b"r").unwrap();
    }
    thread::sleep(Duration::from_millis(250));
    for (a, b) in [
        ("r1.jpg", "s1.jpg"),
        ("r2.jpg", "s2.jpg"),
        ("r3.jpg", "s3.jpg"),
    ] {
        fs::rename(dir.join(a), dir.join(b)).unwrap();
    }
    thread::sleep(Duration::from_millis(400));

    let recs = finish(w, h);
    summarize("events", &recs);
}

fn scenario_burst(root: &Path, n: usize) {
    let dir = root.join("burst");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();

    let t0 = Instant::now();
    let (w, h) = start(root, &dir, t0, Duration::ZERO, false);
    thread::sleep(Duration::from_millis(200));

    println!("\n=== 4 线程新建 {} 个文件 ===", n);
    let t_write = Instant::now();
    let mut handles = Vec::new();
    for t in 0..4 {
        let d = dir.clone();
        handles.push(thread::spawn(move || {
            for i in (t..n).step_by(4) {
                fs::write(d.join(format!("burst_{i:05}.jpg")), b"x").unwrap();
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    println!("写文件耗时 {}ms", ms(t_write.elapsed()));
    thread::sleep(Duration::from_millis(1200));
    let recs = finish(w, h);
    summarize("burst-create", &recs);

    let t0 = Instant::now();
    let (w, h) = start(root, &dir, t0, Duration::ZERO, false);
    thread::sleep(Duration::from_millis(200));
    println!("\n=== 4 线程删除 {} 个文件 ===", n);
    let t_del = Instant::now();
    let mut handles = Vec::new();
    for t in 0..4 {
        let d = dir.clone();
        handles.push(thread::spawn(move || {
            for i in (t..n).step_by(4) {
                fs::remove_file(d.join(format!("burst_{i:05}.jpg"))).unwrap();
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    println!("删除耗时 {}ms", ms(t_del.elapsed()));
    thread::sleep(Duration::from_millis(1000));
    let recs = finish(w, h);
    summarize("burst-delete", &recs);
}

fn scenario_overflow(root: &Path, n: usize, block_ms: u64) {
    let src = root.join("ovf_src");
    let dst = root.join("ovf_dst");
    let _ = fs::remove_dir_all(&src);
    let _ = fs::remove_dir_all(&dst);
    fs::create_dir_all(&src).unwrap();
    fs::create_dir_all(&dst).unwrap();

    println!("\n=== 预置源目录 {} 个文件 ===", n);
    let mut handles = Vec::new();
    for t in 0..4 {
        let d = src.clone();
        handles.push(thread::spawn(move || {
            for i in (t..n).step_by(4) {
                fs::write(d.join(format!("img_{i:05}.jpg")), b"x").unwrap();
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }

    let t0 = Instant::now();
    // 消费者先睡 block_ms：等价于主线程正在解码一屏缩略图
    let (w, h) = start(root, &dst, t0, Duration::from_millis(block_ms), false);
    thread::sleep(Duration::from_millis(300));

    println!(
        "\n=== 消费者阻塞 {}ms，同时 16 线程复制 {} 个文件 ===",
        block_ms, n
    );
    let t_copy = Instant::now();
    let mut handles = Vec::new();
    for t in 0..16 {
        let s = src.clone();
        let d = dst.clone();
        handles.push(thread::spawn(move || {
            for i in (t..n).step_by(16) {
                let name = format!("img_{i:05}.jpg");
                fs::copy(s.join(&name), d.join(&name)).unwrap();
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    println!("复制耗时 {}ms", ms(t_copy.elapsed()));

    thread::sleep(Duration::from_millis(1500));
    println!("\n=== 溢出后新建 after_overflow.jpg，验证监听是否还活着 ===");
    fs::write(dst.join("after_overflow.jpg"), b"z").unwrap();
    thread::sleep(Duration::from_millis(600));

    let recs = finish(w, h);
    summarize("overflow", &recs);

    let failed: Vec<String> = recs
        .iter()
        .filter_map(|r| r.res.as_ref().err().map(|e| format!("{:?}: {}", e.kind, e)))
        .collect();
    println!("[overflow] 错误样本：{:?}", failed);

    let alive = recs.iter().any(|r| {
        r.res
            .as_ref()
            .map(|ev| ev.paths.iter().any(|p| p.ends_with("after_overflow.jpg")))
            .unwrap_or(false)
    });
    println!("[overflow] 溢出后新事件是否到达：{}", alive);

    // 降级路径的成本：溢出后整目录重建（readdir + 全量 metadata）
    let t_rescan = Instant::now();
    let mut count = 0usize;
    let mut total = 0u64;
    if let Ok(rd) = fs::read_dir(&dst) {
        for e in rd.flatten() {
            if let Ok(m) = e.metadata() {
                if m.is_file() {
                    count += 1;
                    total += m.len();
                }
            }
        }
    }
    println!(
        "[overflow] 整目录重建 {} 个文件，耗时 {}ms",
        count,
        ms(t_rescan.elapsed())
    );
    let _ = total;
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("events");
    let root = args
        .get(2)
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("albumio-s6"));
    fs::create_dir_all(&root).unwrap();
    println!("root = {}", root.display());

    match mode {
        "events" => scenario_events(&root),
        "burst" => {
            let n = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1000);
            scenario_burst(&root, n);
        }
        "overflow" => {
            let n = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(6000);
            let block = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(3000);
            scenario_overflow(&root, n, block);
        }
        other => eprintln!("unknown mode: {}", other),
    }
}
