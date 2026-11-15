//! 临时基准：一万项目录里抽 N 张，量 L0/L1 冷启动生成耗时与吞吐。
//! 用法：cargo run --release --example thumb_bench -- <dir> [n]

use albumio_core::cache::Level;
use albumio_core::listing::read_images;
use albumio_core::pipeline::Pipeline;
use std::path::Path;
use std::time::Instant;

fn pct(v: &[u128], p: f64) -> u128 {
    let mut s = v.to_vec();
    s.sort_unstable();
    s[((s.len() as f64 - 1.0) * p).round() as usize]
}

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args.next().expect("需要目录参数");
    let n: usize = args.next().map(|s| s.parse().unwrap()).unwrap_or(60);
    let entries = read_images(Path::new(&dir)).expect("readdir 失败");
    let step = (entries.len() / n).max(1);
    let picks: Vec<_> = entries.iter().step_by(step).take(n).collect();

    let cache = std::env::temp_dir().join("albumio-thumb-bench-cache");
    let _ = std::fs::remove_dir_all(&cache);
    let p = Pipeline::new(&cache).expect("缓存初始化失败");

    for level in [Level::L0, Level::L1] {
        let mut ms = Vec::new();
        let t0 = Instant::now();
        for e in &picks {
            let r = p.thumbnail(Path::new(&e.path), level).expect("缩略图失败");
            ms.push(r.elapsed_ms);
        }
        let total = t0.elapsed().as_millis();
        println!(
            "{:?}: n={} 总 {} ms，单张 p50 {} ms / p95 {} ms，吞吐 {:.1} 张/秒",
            level,
            picks.len(),
            total,
            pct(&ms, 0.5),
            pct(&ms, 0.95),
            picks.len() as f64 * 1000.0 / total as f64
        );
        // 二次调用（全命中缓存）
        let t1 = Instant::now();
        for e in &picks {
            p.thumbnail(Path::new(&e.path), level)
                .expect("缓存命中失败");
        }
        println!(
            "  缓存命中：总 {} ms，单张 {:.2} ms",
            t1.elapsed().as_millis(),
            t1.elapsed().as_millis() as f64 / picks.len() as f64
        );
    }
    let _ = std::fs::remove_dir_all(&cache);
}
