//! 删除与撤销（`02-设计规范.md` §11.6）。
//!
//! 两个入口：移到系统回收站（可撤销）与永久删除（不可撤销）。批量按条目返回
//! 结果、单个失败不阻断其余条目——用户选 30 张时若其中 1 张被别的程序占用，
//! 不能因此 29 张都不动，也不能让用户以为全部成功。

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFailure {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    /// 成功条目的原路径（按调用顺序）。
    pub deleted: Vec<String>,
    pub failed: Vec<DeleteFailure>,
    /// 这次删除能否撤销。前端据此决定 Toast 里要不要出「撤销」。
    pub can_undo: bool,
    /// 删除发生的 Unix 秒；撤销时用它排除回收站里同名的旧条目。
    pub at: i64,
}

/// Windows 与 Freedesktop 回收站提供按条目还原；macOS 的系统回收站
/// 没有公开的还原接口（`trash` crate 的 `os_limited` 也不覆盖 macOS）。
pub const fn can_restore() -> bool {
    cfg!(any(target_os = "windows", target_os = "linux"))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 把 8.3 短路径还原成长路径。文件本身已被删掉，只能 canonicalize 它的父目录
/// （父目录一定还在），再拼回文件名。
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn long_form(path: &Path) -> Option<std::path::PathBuf> {
    let parent = path.parent()?;
    let name = path.file_name()?;
    let canon = std::fs::canonicalize(parent).ok()?;
    // canonicalize 返回的是 `\\?\C:\...` 形式的 verbatim 路径，回收站记录里没有这个前缀。
    let s = canon.to_string_lossy();
    let plain = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.to_string()
    };
    Some(std::path::PathBuf::from(plain).join(name))
}

/// Windows 大小写不敏感，回收站记录的大小写与调用方可能不同。
#[cfg(any(target_os = "windows", target_os = "linux"))]
fn same_path(a: &Path, b: &Path) -> bool {
    a == b
        || (cfg!(windows) && a.to_string_lossy().eq_ignore_ascii_case(&b.to_string_lossy()))
}

/// 移到系统回收站：单文件 `Delete` 也走这里（不弹框，§11.6.1）。
pub fn move_to_trash(paths: &[String]) -> DeleteOutcome {
    let mut out = DeleteOutcome {
        can_undo: can_restore(),
        at: now_secs(),
        ..Default::default()
    };
    for p in paths {
        match trash::delete(p) {
            Ok(()) => out.deleted.push(p.clone()),
            Err(e) => out.failed.push(DeleteFailure {
                path: p.clone(),
                reason: e.to_string(),
            }),
        }
    }
    out
}

/// 永久删除：先看元数据再按文件/目录分派，避免把目录当文件删掉。
pub fn delete_permanent(paths: &[String]) -> DeleteOutcome {
    let mut out = DeleteOutcome::default();
    for p in paths {
        let path = Path::new(p);
        let result = std::fs::symlink_metadata(path).and_then(|m| {
            if m.is_dir() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            }
        });
        match result {
            Ok(()) => out.deleted.push(p.clone()),
            Err(e) => out.failed.push(DeleteFailure {
                path: p.clone(),
                reason: e.to_string(),
            }),
        }
    }
    out
}

/// 撤销：把刚移进回收站的条目还原回原路径。
///
/// `since` 是删除时返回的 Unix 秒；回收站里同一个路径可能有多条历史记录，
/// 只认 `since` 之后（留 2 秒余量）的最新一条，避免把几年前删的同名文件捞回来。
///
/// Linux 走 Freedesktop 的 `trash` 列表；Windows **不走** `trash::os_limited::list()`：
/// 那会逐条读 Shell 属性，实测 17k 条要 30 s，撤销按钮不能这么等。改为直接读
/// `X:\$Recycle.Bin\<SID>\` 下的 `$I`（元数据）/`$R`（本体）配对记录，一次目录扫描
/// 就能定位，代价是依赖这个自 Vista 起未变的布局。
#[cfg(target_os = "linux")]
pub fn restore(paths: &[String], since: i64) -> DeleteOutcome {
    let mut out = DeleteOutcome {
        can_undo: true,
        at: now_secs(),
        ..Default::default()
    };
    let items = match trash::os_limited::list() {
        Ok(v) => v,
        Err(e) => {
            let reason = e.to_string();
            for p in paths {
                out.failed.push(DeleteFailure {
                    path: p.clone(),
                    reason: reason.clone(),
                });
            }
            return out;
        }
    };
    for p in paths {
        let raw = Path::new(p);
        // 回收站记录的是长路径，调用方给的可能是 8.3 短路径（`TYLERZ~1`）或反过来的
        // 大小写差异；两边都归一化后再比。
        let long = long_form(raw);
        let hit = items
            .iter()
            .filter(|i| {
                let op = i.original_path();
                i.time_deleted >= since - 2
                    && (same_path(&op, raw) || long.as_deref().is_some_and(|l| same_path(&op, l)))
            })
            .max_by_key(|i| i.time_deleted)
            .cloned();
        let Some(item) = hit else {
            out.failed.push(DeleteFailure {
                path: p.clone(),
                reason: "回收站里找不到这次删除的记录".into(),
            });
            continue;
        };
        // 一次只还原一条：多条里的路径冲突会让整批回滚（`Error::RestoreCollision`）。
        match trash::os_limited::restore_all(vec![item]) {
            Ok(()) => out.deleted.push(p.clone()),
            Err(e) => out.failed.push(DeleteFailure {
                path: p.clone(),
                reason: e.to_string(),
            }),
        }
    }
    out
}

#[cfg(target_os = "windows")]
pub fn restore(paths: &[String], since: i64) -> DeleteOutcome {
    let mut out = DeleteOutcome {
        can_undo: true,
        at: now_secs(),
        ..Default::default()
    };
    // 只扫这几个路径所在的卷，不枚举所有盘符（网络盘 is_dir 会卡住）。
    let mut bins: Vec<std::path::PathBuf> = Vec::new();
    for p in paths {
        if let Some(bin) = recycle_bin_dir(Path::new(p)) {
            if !bins.contains(&bin) {
                bins.push(bin);
            }
        }
    }
    let records = scan_records(&bins, since);
    for p in paths {
        let raw = Path::new(p);
        // 回收站记录的是长路径，调用方给的可能是 8.3 短路径（`TYLERZ~1`）。
        let long = long_form(raw);
        let hit = records
            .iter()
            .filter(|r| {
                same_path(&r.original, raw)
                    || long.as_deref().is_some_and(|l| same_path(&r.original, l))
            })
            .max_by_key(|r| r.deleted_at)
            .cloned();
        let Some(rec) = hit else {
            out.failed.push(DeleteFailure {
                path: p.clone(),
                reason: "回收站里找不到这次删除的记录".into(),
            });
            continue;
        };
        match put_back(&rec) {
            Ok(()) => out.deleted.push(p.clone()),
            Err(reason) => out.failed.push(DeleteFailure {
                path: p.clone(),
                reason,
            }),
        }
    }
    out
}

/// Windows 回收站的一条 `$I`/`$R` 配对。
#[cfg(target_os = "windows")]
#[derive(Clone)]
struct RecycleRecord {
    /// `$I` 元数据文件（删除时间 + 原路径 + 原大小）。
    i_path: std::path::PathBuf,
    /// `$R` 本体。
    r_path: std::path::PathBuf,
    original: std::path::PathBuf,
    deleted_at: i64,
}

/// `X:\$Recycle.Bin`；卷不存在回收站（U 盘 FAT、网络盘）时返回 None。
#[cfg(target_os = "windows")]
fn recycle_bin_dir(path: &Path) -> Option<std::path::PathBuf> {
    let s = path.to_string_lossy();
    let b = s.as_bytes();
    if b.len() < 3 || b[1] != b':' {
        return None;
    }
    let bin = std::path::PathBuf::from(format!("{}:\\$Recycle.Bin", &s[..1]));
    bin.is_dir().then_some(bin)
}

#[cfg(target_os = "windows")]
fn scan_records(bins: &[std::path::PathBuf], since: i64) -> Vec<RecycleRecord> {
    let mut out = Vec::new();
    for bin in bins {
        let Ok(subs) = std::fs::read_dir(bin) else {
            continue;
        };
        for sub in subs.flatten() {
            let dir = sub.path();
            if !sub.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            // 一次 FindFirstFileW 拿全文件名与修改时间，不做逐条 stat
            // （S4 实测 1 万条 stat 要 835 ms）。
            for (name, deleted_at) in i_files_with_time(&dir) {
                if deleted_at + 2 < since {
                    continue;
                }
                let i_path = dir.join(&name);
                let Some(original) = parse_i_record(&i_path) else {
                    continue;
                };
                out.push(RecycleRecord {
                    r_path: dir.join(format!("$R{}", &name[2..])),
                    i_path,
                    original,
                    deleted_at,
                });
            }
        }
    }
    out
}

/// 扫描一个目录下所有 `$I*` 文件，返回（文件名, 修改时间 Unix 秒）。
#[cfg(target_os = "windows")]
fn i_files_with_time(dir: &Path) -> Vec<(String, i64)> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        FindClose, FindFirstFileW, FindNextFileW, WIN32_FIND_DATAW,
    };

    let pattern = dir.join("$I*");
    let mut wide: Vec<u16> = pattern.to_string_lossy().encode_utf16().collect();
    wide.push(0);
    let mut data: WIN32_FIND_DATAW = unsafe { std::mem::zeroed() };
    let handle = unsafe { FindFirstFileW(wide.as_ptr(), &mut data) };
    if handle == INVALID_HANDLE_VALUE {
        return Vec::new();
    }
    let mut out = Vec::new();
    loop {
        let name = String::from_utf16_lossy(
            &data
                .cFileName
                .iter()
                .take_while(|&&c| c != 0)
                .copied()
                .collect::<Vec<u16>>(),
        );
        if name.starts_with("$I") && name.len() > 2 {
            out.push((name, filetime_to_unix(data.ftLastWriteTime)));
        }
        if unsafe { FindNextFileW(handle, &mut data) } == 0 {
            break;
        }
    }
    unsafe { FindClose(handle) };
    out
}

#[cfg(target_os = "windows")]
fn filetime_to_unix(ft: windows_sys::Win32::Foundation::FILETIME) -> i64 {
    let ticks = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
    if ticks == 0 {
        return 0;
    }
    // FILETIME 是 1601-01-01 起的 100 ns 计数。
    (ticks / 10_000_000) as i64 - 11_644_473_600
}

/// `$I` 记录：8 字节版本 + 8 字节原大小 + 8 字节删除时间 + 原路径。
/// 版本 2（Win10 起）第 24 字节是字符数（含结尾 NUL）；更早的版本是 260 个 WCHAR 定长。
#[cfg(target_os = "windows")]
fn parse_i_record(file: &Path) -> Option<std::path::PathBuf> {
    let data = std::fs::read(file).ok()?;
    if data.len() < 28 {
        return None;
    }
    let version = u64::from_le_bytes(data[0..8].try_into().ok()?);
    let (offset, chars) = if version >= 2 {
        (
            28usize,
            u32::from_le_bytes(data[24..28].try_into().ok()?) as usize,
        )
    } else {
        (24usize, 260usize)
    };
    let bytes = data.get(offset..)?;
    let take = (chars * 2).min(bytes.len());
    let units: Vec<u16> = bytes[..take]
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let s = String::from_utf16_lossy(&units);
    let s = s.trim_end_matches('\0');
    (!s.is_empty()).then(|| std::path::PathBuf::from(s))
}

#[cfg(target_os = "windows")]
fn put_back(rec: &RecycleRecord) -> Result<(), String> {
    if !rec.r_path.exists() {
        return Err("回收站里找不到文件本体".into());
    }
    if rec.original.exists() {
        return Err("原位置已有同名文件".into());
    }
    if let Some(parent) = rec.original.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&rec.r_path, &rec.original).map_err(|e| e.to_string())?;
    // 本体已还原，`$I` 清不掉只是回收站里留一条空记录，不该算撤销失败。
    let _ = std::fs::remove_file(&rec.i_path);
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub fn restore(paths: &[String], _since: i64) -> DeleteOutcome {
    DeleteOutcome {
        failed: paths
            .iter()
            .map(|p| DeleteFailure {
                path: p.clone(),
                reason: "此平台不支持从回收站还原".into(),
            })
            .collect(),
        can_undo: false,
        at: now_secs(),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "albumio-ops-{tag}-{}-{}",
            std::process::id(),
            now_secs()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn permanent_delete_removes_files_and_reports_missing() {
        let dir = temp_dir("perm");
        let a = dir.join("a.jpg");
        let b = dir.join("b.jpg");
        std::fs::write(&a, b"x").unwrap();
        std::fs::write(&b, b"y").unwrap();
        let missing = dir.join("gone.jpg").display().to_string();

        let out = delete_permanent(&[
            a.display().to_string(),
            b.display().to_string(),
            missing.clone(),
        ]);

        assert_eq!(out.deleted.len(), 2);
        assert!(!a.exists() && !b.exists());
        assert_eq!(out.failed.len(), 1);
        assert_eq!(out.failed[0].path, missing);
        assert!(!out.can_undo);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn permanent_delete_handles_directory() {
        let dir = temp_dir("dir");
        let sub = dir.join("sub");
        std::fs::create_dir_all(sub.join("inner")).unwrap();
        std::fs::write(sub.join("inner/x.jpg"), b"x").unwrap();

        let out = delete_permanent(&[sub.display().to_string()]);

        assert_eq!(out.deleted.len(), 1);
        assert!(!sub.exists());
        assert!(dir.exists(), "只删目标目录，不连带父目录");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restore_is_reported_per_platform() {
        // 不真的调用回收站：只验证能力位与「不支持的平台给逐条失败」的契约。
        if can_restore() {
            assert!(can_restore());
        } else {
            let out = restore(&["C:/不存在.jpg".into()], 0);
            assert!(out.failed.len() == 1 && !out.can_undo);
        }
    }
}
