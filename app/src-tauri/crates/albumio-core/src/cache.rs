//! 缩略图缓存：key 规则、分片目录、原子写、容量淘汰。
//!
//! key = xxh3_128(规范化绝对路径小写 | 文件大小 | mtime(ns) | 管线版本号)，前 2 位十六进制做分片目录。
//! 任一输入变化 key 自然失效，不做"清理过期缓存"的逻辑（`01-方案文档.md` §1.3）。

use crate::{Error, Result};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 算法或编码参数变更时 +1，等于全库缓存自动失效。
pub const PIPELINE_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// 32px 占位
    L0,
    /// 256px 网格
    L1,
    /// 2048px 代理
    L2,
}

impl Level {
    pub fn dir(self) -> &'static str {
        match self {
            Level::L0 => "l0",
            Level::L1 => "l1",
            Level::L2 => "l2",
        }
    }

    pub fn edge(self) -> u32 {
        match self {
            Level::L0 => 32,
            Level::L1 => 256,
            Level::L2 => 2048,
        }
    }

    /// 容量预算：L1 2GB、L2 4GB；L0 单体 < 1KB，不设预算（`01-方案文档.md` §1.3）。
    pub fn budget_bytes(self) -> Option<u64> {
        match self {
            Level::L0 => None,
            Level::L1 => Some(2 * 1024 * 1024 * 1024),
            Level::L2 => Some(4 * 1024 * 1024 * 1024),
        }
    }

    pub fn from_name(name: &str) -> Option<Level> {
        match name {
            "l0" => Some(Level::L0),
            "l1" => Some(Level::L1),
            "l2" => Some(Level::L2),
            _ => None,
        }
    }
}

/// 缓存根目录为 `<数据目录>/albumio/thumbs`。
pub struct Cache {
    root: PathBuf,
}

impl Cache {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        fs::create_dir_all(root.join("l0"))?;
        fs::create_dir_all(root.join("l1"))?;
        fs::create_dir_all(root.join("l2"))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 由文件元信息算 key（128bit xxh3，32 位十六进制）。
    pub fn key_for(path: &Path, size: u64, mtime_ns: i128) -> String {
        let norm = normalize_path(path);
        let input = format!("{norm}|{size}|{mtime_ns}|{PIPELINE_VERSION}");
        format!("{:032x}", xxhash_rust::xxh3::xxh3_128(input.as_bytes()))
    }

    pub fn path_for(&self, level: Level, key: &str) -> PathBuf {
        let shard = &key[..2.min(key.len())];
        self.root
            .join(level.dir())
            .join(shard)
            .join(format!("{key}.webp"))
    }

    /// 命中返回字节，并把文件 mtime 刷新为"现在"当作临时 LRU 依据。
    /// M4 建 `thumb_meta` 后改为写库（`01-方案文档.md` §1.3）。
    pub fn read(&self, level: Level, key: &str) -> Option<Vec<u8>> {
        let path = self.path_for(level, key);
        let bytes = fs::read(&path).ok()?;
        if bytes.is_empty() {
            let _ = fs::remove_file(&path);
            return None;
        }
        if let Ok(f) = fs::OpenOptions::new().write(true).open(&path) {
            let _ = f.set_modified(SystemTime::now());
        }
        Some(bytes)
    }

    /// 写 `*.tmp` → fsync → rename，崩溃后不会出现半张图。
    pub fn write(&self, level: Level, key: &str, bytes: &[u8]) -> Result<PathBuf> {
        let path = self.path_for(level, key);
        let dir = path
            .parent()
            .ok_or_else(|| Error::Invalid("缓存路径无父目录".into()))?;
        fs::create_dir_all(dir)?;
        let tmp = dir.join(format!(".{key}.{}.tmp", std::process::id()));
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
        }
        fs::rename(&tmp, &path)?;
        Ok(path)
    }

    pub fn remove(&self, level: Level, key: &str) {
        let _ = fs::remove_file(self.path_for(level, key));
    }

    /// 按预算淘汰最久未用的文件，返回释放的字节数。
    pub fn sweep(&self, level: Level) -> Result<u64> {
        let Some(budget) = level.budget_bytes() else {
            return Ok(0);
        };
        let mut files: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
        let mut total = 0u64;
        let dir = self.root.join(level.dir());
        collect(&dir, &mut files, &mut total)?;
        if total <= budget {
            return Ok(0);
        }
        files.sort_by_key(|(t, _, _)| *t);
        let mut freed = 0u64;
        for (_, size, path) in files {
            if total - freed <= budget {
                break;
            }
            if fs::remove_file(&path).is_ok() {
                freed += size;
            }
        }
        Ok(freed)
    }
}

fn collect(dir: &Path, out: &mut Vec<(SystemTime, u64, PathBuf)>, total: &mut u64) -> Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            collect(&path, out, total)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("webp") {
            *total += meta.len();
            out.push((
                meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                meta.len(),
                path,
            ));
        }
    }
    Ok(())
}

fn normalize_path(path: &Path) -> String {
    let abs = fs::canonicalize(path).unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|c| c.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        }
    });
    abs.to_string_lossy().to_lowercase()
}

pub fn mtime_ns(meta: &fs::Metadata) -> i128 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as i128)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_changes_with_mtime_and_version_is_part_of_it() {
        let p = Path::new("C:/tmp/a.jpg");
        let k1 = Cache::key_for(p, 100, 1_000);
        let k2 = Cache::key_for(p, 100, 1_001);
        assert_ne!(k1, k2);
        assert_eq!(k1.len(), 32);
        assert_ne!(Cache::key_for(p, 101, 1_000), k1);
    }

    #[test]
    fn shard_dir_is_first_two_hex() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = Cache::new(tmp.path().join("thumbs")).unwrap();
        let key = "abcdef0123456789abcdef0123456789";
        let p = cache.path_for(Level::L1, key);
        assert!(p.ends_with("l1/ab/abcdef0123456789abcdef0123456789.webp"));
    }

    #[test]
    fn write_read_and_atomic_tmp_cleanup() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = Cache::new(tmp.path().join("thumbs")).unwrap();
        let key = Cache::key_for(Path::new("C:/tmp/a.jpg"), 10, 20);
        cache.write(Level::L1, &key, b"hello").unwrap();
        assert_eq!(cache.read(Level::L1, &key).unwrap(), b"hello");
        let dir = cache
            .path_for(Level::L1, &key)
            .parent()
            .unwrap()
            .to_path_buf();
        let leftovers: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不应残留 tmp 文件");
    }
}
