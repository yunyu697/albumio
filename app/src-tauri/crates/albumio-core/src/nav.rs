//! 侧栏导航数据（04-项目计划 M3）：根节点、子目录、磁盘用量。
//!
//! 全部是 readdir 级别的开销：子目录只读一级、图片数只数直接子文件（不递归），
//! 展开一层才读一层。不要把这里做成"扫描整盘"——folder-first 的前提是打开就出结果。

use crate::listing::has_image_ext;
use crate::Result;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubDir {
    pub name: String,
    pub path: String,
    /// 直接子文件里的图片数（不递归）。
    pub images: u64,
    /// 直接子目录数。为 0 时侧栏不显示展开箭头。
    pub dirs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    /// 盘符或挂载点显示名，例如 `C:`。
    pub label: String,
    pub free_bytes: u64,
    pub total_bytes: u64,
}

/// 根节点：Windows 是可见盘符，Unix 是 `/` 与主目录。
#[cfg(windows)]
pub fn roots() -> Vec<Root> {
    use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let path = format!("{letter}:\\");
        if !Path::new(&path).exists() {
            continue;
        }
        let name = match volume_label(&path) {
            Some(label) => format!("{label} ({letter}:)"),
            None => format!("{letter}:"),
        };
        out.push(Root { name, path });
    }
    out
}

#[cfg(windows)]
fn volume_label(root: &str) -> Option<String> {
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW;
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    let mut buf = [0u16; 64];
    let ok = unsafe {
        GetVolumeInformationW(
            wide.as_ptr(),
            buf.as_mut_ptr(),
            buf.len() as u32,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    if ok == 0 {
        return None;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(0);
    if end == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..end]))
}

#[cfg(unix)]
pub fn roots() -> Vec<Root> {
    let mut out = vec![Root {
        name: "/".into(),
        path: "/".into(),
    }];
    if let Some(home) = std::env::var_os("HOME") {
        let p = PathBuf::from(home);
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "主目录".into());
        out.push(Root {
            name,
            path: p.display().to_string(),
        });
    }
    out
}

/// 直接子目录（按名称自然序），带各自的直接图片数。单个子目录读不动就跳过它。
pub fn subdirs(dir: &Path) -> Result<Vec<SubDir>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        // 隐藏目录（.git / $RECYCLE.BIN / System Volume Information 之类）不进树。
        if name.starts_with('.') || name.starts_with('$') {
            continue;
        }
        let (images, dirs) = count_children(&entry.path());
        out.push(SubDir {
            path: entry.path().display().to_string(),
            name,
            images,
            dirs,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// 一次 readdir 同时拿到直接图片数与直接子目录数（侧栏箭头是否可见要用后者）。
fn count_children(dir: &Path) -> (u64, u64) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return (0, 0);
    };
    let mut images = 0;
    let mut dirs = 0;
    for e in rd.flatten() {
        if e.file_type().map(|t| t.is_dir()).unwrap_or(true) {
            dirs += 1;
            continue;
        }
        if has_image_ext(&e.file_name().to_string_lossy()) {
            images += 1;
        }
    }
    (images, dirs)
}

/// 目录所在卷的用量。取不到（网络路径、权限）就返回 None，UI 不显示该块。
#[cfg(windows)]
pub fn disk(dir: &Path) -> Option<DiskInfo> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let root = Path::new(dir).components().next()?;
    let mut root = PathBuf::from(root.as_os_str());
    root.push("\\");
    let wide: Vec<u16> = root
        .display()
        .to_string()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut free = 0u64;
    let mut total = 0u64;
    let ok =
        unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, std::ptr::null_mut()) };
    if ok == 0 || total == 0 {
        return None;
    }
    let label = root
        .display()
        .to_string()
        .trim_end_matches('\\')
        .to_string();
    Some(DiskInfo {
        label,
        free_bytes: free,
        total_bytes: total,
    })
}

#[cfg(unix)]
pub fn disk(dir: &Path) -> Option<DiskInfo> {
    use std::ffi::CString;
    let c = CString::new(dir.display().to_string()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c.as_ptr(), &mut st) };
    if rc != 0 {
        return None;
    }
    let total = st.f_blocks as u64 * st.f_frsize as u64;
    let free = st.f_bavail as u64 * st.f_frsize as u64;
    if total == 0 {
        return None;
    }
    Some(DiskInfo {
        label: "/".into(),
        free_bytes: free,
        total_bytes: total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subdirs_skips_hidden_and_counts_images() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("旅行")).unwrap();
        std::fs::create_dir_all(tmp.path().join(".git")).unwrap();
        std::fs::create_dir_all(tmp.path().join("$RECYCLE.BIN")).unwrap();
        std::fs::write(tmp.path().join("旅行/a.jpg"), b"x").unwrap();
        std::fs::write(tmp.path().join("旅行/b.txt"), b"x").unwrap();
        std::fs::write(tmp.path().join("旅行/c.PNG"), b"x").unwrap();
        let list = subdirs(tmp.path()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "旅行");
        assert_eq!(list[0].images, 2);
    }

    #[test]
    fn disk_of_existing_dir_has_total() {
        let tmp = tempfile::tempdir().unwrap();
        let d = disk(tmp.path()).expect("临时目录所在卷应能取到用量");
        assert!(d.total_bytes > 0);
        assert!(d.free_bytes <= d.total_bytes);
    }

    #[test]
    fn roots_not_empty() {
        assert!(!roots().is_empty());
    }
}
