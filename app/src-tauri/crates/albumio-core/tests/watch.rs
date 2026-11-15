//! M8 目录监听的端到端测试：真实 `notify` + 真实文件操作。
//!
//! 去抖参数压到 80–300 ms 让测试快跑；生产默认值见 `watch::Debounce::default`。

use albumio_core::watch::{Debounce, DirChanges, DirWatcher};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

fn debounce() -> Debounce {
    Debounce {
        quiet: Duration::from_millis(80),
        max: Duration::from_millis(300),
    }
}

fn wait_for(
    rx: &Receiver<DirChanges>,
    timeout: Duration,
    mut pred: impl FnMut(&DirChanges) -> bool,
) -> DirChanges {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            panic!("等待监听批次超时");
        }
        match rx.recv_timeout(left.min(Duration::from_millis(100))) {
            Ok(c) => {
                if pred(&c) {
                    return c;
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => panic!("监听线程提前结束"),
        }
    }
}

fn abs(p: &Path) -> String {
    p.display().to_string()
}

/// 监听启动后先等一拍，避免把 notify 的初始化事件算进用例。
fn settle() {
    thread::sleep(Duration::from_millis(250));
}

#[test]
fn rename_is_reported_as_rename_not_delete_and_create() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.jpg");
    fs::write(&a, b"x").unwrap();

    let (tx, rx) = channel();
    let watcher = DirWatcher::start(dir.path(), debounce(), move |c| {
        let _ = tx.send(c);
    })
    .unwrap();
    settle();

    let z = dir.path().join("z.jpg");
    fs::rename(&a, &z).unwrap();

    let batch = wait_for(&rx, Duration::from_secs(3), |c| {
        c.renamed.iter().any(|r| r.from == abs(&a))
    });
    let pair = batch.renamed.iter().find(|r| r.from == abs(&a)).unwrap();
    assert_eq!(pair.to, abs(&z));
    assert!(batch
        .upserts
        .iter()
        .any(|e| e.path == abs(&z) && e.name == "z.jpg"));
    assert!(batch.removed.contains(&abs(&a)));
    watcher.stop();
}

#[test]
fn create_and_delete_are_reflected_in_separate_batches() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = channel();
    let watcher = DirWatcher::start(dir.path(), debounce(), move |c| {
        let _ = tx.send(c);
    })
    .unwrap();
    settle();

    let f = dir.path().join("new.jpg");
    fs::write(&f, vec![0u8; 32]).unwrap();
    let created = wait_for(&rx, Duration::from_secs(3), |c| {
        c.upserts.iter().any(|e| e.path == abs(&f))
    });
    assert!(created.removed.is_empty());

    fs::remove_file(&f).unwrap();
    let removed = wait_for(&rx, Duration::from_secs(3), |c| {
        c.removed.contains(&abs(&f))
    });
    assert!(
        !removed.upserts.iter().any(|e| e.path == abs(&f)),
        "删除不应再带同名 upsert"
    );
    watcher.stop();
}

#[test]
fn burst_of_creates_is_merged_into_a_few_batches() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = channel();
    let watcher = DirWatcher::start(dir.path(), debounce(), move |c| {
        let _ = tx.send(c);
    })
    .unwrap();
    settle();

    let mut wanted = Vec::new();
    for i in 0..20 {
        let p = dir.path().join(format!("burst_{i:02}.jpg"));
        fs::write(&p, b"x").unwrap();
        wanted.push(abs(&p));
    }

    let mut seen = std::collections::HashSet::new();
    let mut batches = 0;
    let deadline = Instant::now() + Duration::from_secs(4);
    while seen.len() < wanted.len() && Instant::now() < deadline {
        let left = deadline.saturating_duration_since(Instant::now());
        match rx.recv_timeout(left.min(Duration::from_millis(120))) {
            Ok(c) => {
                batches += 1;
                for e in c.upserts {
                    seen.insert(e.path);
                }
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    assert_eq!(seen.len(), wanted.len(), "20 个新建应全部到齐");
    assert!(batches <= 4, "去抖后应合并成少量批次，实际 {batches}");
    watcher.stop();
}

#[test]
fn ignored_files_do_not_produce_batches() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = channel();
    let watcher = DirWatcher::start(dir.path(), debounce(), move |c| {
        let _ = tx.send(c);
    })
    .unwrap();
    settle();

    fs::write(dir.path().join("notes.txt"), b"x").unwrap();
    fs::write(dir.path().join("photo.jpg.part"), b"x").unwrap();
    fs::write(dir.path().join("Thumbs.db"), b"x").unwrap();

    match rx.recv_timeout(Duration::from_millis(700)) {
        Ok(c) => panic!("非图片/中转文件不应产生批次：{c:?}"),
        Err(RecvTimeoutError::Timeout) => {}
        Err(RecvTimeoutError::Disconnected) => panic!("监听线程提前结束"),
    }
    watcher.stop();
}

#[test]
fn stop_ends_delivery() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, rx) = channel();
    let watcher = DirWatcher::start(dir.path(), debounce(), move |c| {
        let _ = tx.send(c);
    })
    .unwrap();
    settle();
    watcher.stop();

    fs::write(dir.path().join("after_stop.jpg"), b"x").unwrap();
    thread::sleep(Duration::from_millis(500));
    assert!(rx.try_recv().is_err(), "stop 之后不应再收到批次");
}

/// 改名后旧路径的评分要能迁移：批次里同时给 renamed 与 stat 校正后的增删。
#[test]
fn rename_batch_carries_both_side_entries() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("keep.jpg");
    fs::write(&a, b"x").unwrap();
    let (tx, rx) = channel();
    let watcher = DirWatcher::start(dir.path(), debounce(), move |c| {
        let _ = tx.send(c);
    })
    .unwrap();
    settle();

    let b = dir.path().join("kept.jpg");
    fs::rename(&a, &b).unwrap();
    let batch = wait_for(&rx, Duration::from_secs(3), |c| !c.renamed.is_empty());
    let entry = batch
        .upserts
        .iter()
        .find(|e| e.path == abs(&b))
        .unwrap_or_else(|| panic!("新路径应带 stat：{batch:?}"));
    assert!(entry.size > 0);
    assert!(batch.removed.contains(&abs(&a)));
    watcher.stop();
}

#[test]
fn watcher_reports_its_directory() {
    let dir = tempfile::tempdir().unwrap();
    let path: PathBuf = dir.path().to_path_buf();
    let watcher = DirWatcher::start(&path, debounce(), |_| {}).unwrap();
    assert_eq!(watcher.dir(), path.as_path());
    watcher.stop();
}
