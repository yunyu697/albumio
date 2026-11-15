//! SQLite 索引（04-项目计划 M4）。
//!
//! **folder-first 硬约束**：索引只是加速层。`index.db` 被删、损坏、不可写时，
//! 浏览 / 看图 / 编辑 / 导出必须全部照常——所有调用点都只把它当"可以失败"的旁路。
//!
//! 表结构覆盖后续里程碑（`edits` 给 M6、`fts_files` 给搜索），迁移用 `PRAGMA user_version`。

use crate::meta::PhotoMeta;
use crate::{Error, Result};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub files: u64,
    pub dirs: u64,
    pub tags: u64,
    pub schema: i64,
    pub bytes: u64,
}

pub struct Index {
    path: PathBuf,
    conn: Mutex<Connection>,
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dirs (
  id         INTEGER PRIMARY KEY,
  path       TEXT NOT NULL UNIQUE,
  mtime_ns   INTEGER,
  indexed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path           TEXT PRIMARY KEY,
  dir            TEXT NOT NULL,
  name           TEXT NOT NULL,
  size           INTEGER NOT NULL,
  mtime_ns       INTEGER NOT NULL,
  format         TEXT,
  width          INTEGER,
  height         INTEGER,
  taken_at       INTEGER,
  taken_source   TEXT,
  orientation    INTEGER,
  rating         INTEGER,
  title          TEXT,
  keywords       TEXT,
  rights         TEXT,
  camera         TEXT,
  lens           TEXT,
  exposure       TEXT,
  iso            INTEGER,
  focal          REAL,
  icc            TEXT,
  meta_json      TEXT NOT NULL,
  indexed_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_dir ON files(dir);
CREATE INDEX IF NOT EXISTS files_taken ON files(taken_at);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS file_tags (
  path   TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (path, tag_id)
);

CREATE TABLE IF NOT EXISTS edits (
  path       TEXT PRIMARY KEY,
  ops        TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_files USING fts5(
  path UNINDEXED,
  name,
  title,
  keywords,
  camera,
  tokenize = 'unicode61 remove_diacritics 2'
);
"#;

impl Index {
    /// 打开（或创建）索引。调用方必须容忍失败：失败就当没有索引继续跑。
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(&path)?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        migrate(&conn)?;
        Ok(Self {
            path,
            conn: Mutex::new(conn),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 把一张图的合并结果写进索引。索引写失败不应影响看图，所以调用方只记日志。
    pub fn upsert(&self, meta: &PhotoMeta) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        let now = now_ms();
        let json = serde_json::to_string(meta)?;
        let keywords = meta.keywords.join(", ");
        let dir = Path::new(&meta.path)
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let taken_source = meta.taken_source.map(|s| format!("{s:?}").to_lowercase());

        conn.execute(
            "INSERT INTO files (
                path, dir, name, size, mtime_ns, format, width, height, taken_at, taken_source,
                orientation, rating, title, keywords, rights, camera, lens, exposure, iso, focal,
                icc, meta_json, indexed_at
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)
             ON CONFLICT(path) DO UPDATE SET
                dir=excluded.dir, name=excluded.name, size=excluded.size,
                mtime_ns=excluded.mtime_ns, format=excluded.format, width=excluded.width,
                height=excluded.height, taken_at=excluded.taken_at,
                taken_source=excluded.taken_source, orientation=excluded.orientation,
                rating=excluded.rating, title=excluded.title, keywords=excluded.keywords,
                rights=excluded.rights, camera=excluded.camera, lens=excluded.lens,
                exposure=excluded.exposure, iso=excluded.iso, focal=excluded.focal,
                icc=excluded.icc, meta_json=excluded.meta_json, indexed_at=excluded.indexed_at",
            params![
                meta.path,
                dir,
                meta.name,
                meta.size as i64,
                meta.mtime_ns as i64,
                meta.format,
                meta.width,
                meta.height,
                meta.taken_at,
                taken_source,
                meta.orientation,
                meta.rating,
                meta.title,
                keywords,
                meta.rights,
                meta.camera,
                meta.lens,
                meta.exposure,
                meta.iso,
                meta.focal,
                meta.icc,
                json,
                now,
            ],
        )?;

        conn.execute("DELETE FROM fts_files WHERE path = ?1", params![meta.path])?;
        conn.execute(
            "INSERT INTO fts_files (path, name, title, keywords, camera) VALUES (?1,?2,?3,?4,?5)",
            params![
                meta.path,
                meta.name,
                meta.title,
                keywords,
                meta.camera,
            ],
        )?;
        Ok(())
    }

    pub fn tags(&self, path: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT t.name FROM tags t
             JOIN file_tags ft ON ft.tag_id = t.id
             WHERE ft.path = ?1 ORDER BY t.name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map(params![path], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn add_tag(&self, path: &str, tag: &str) -> Result<Vec<String>> {
        let tag = tag.trim();
        if tag.is_empty() {
            return self.tags(path);
        }
        {
            let conn = self.conn.lock().unwrap();
            conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?1)", params![tag])?;
            let id: i64 = conn.query_row("SELECT id FROM tags WHERE name = ?1", params![tag], |r| {
                r.get(0)
            })?;
            conn.execute(
                "INSERT OR IGNORE INTO file_tags (path, tag_id) VALUES (?1, ?2)",
                params![path, id],
            )?;
        }
        self.tags(path)
    }

    pub fn remove_tag(&self, path: &str, tag: &str) -> Result<Vec<String>> {
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "DELETE FROM file_tags WHERE path = ?1 AND tag_id = (SELECT id FROM tags WHERE name = ?2)",
                params![path, tag],
            )?;
        }
        self.tags(path)
    }

    /// FTS5 搜索（M4 只验证通路；搜索框接线在 M3/M8 之后）。
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<String>> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT path FROM fts_files WHERE fts_files MATCH ?1 ORDER BY rank LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![format!("\"{}\"", q.replace('"', "\"\"")), limit as i64], |r| {
            r.get::<_, String>(0)
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 读取编辑栈（M6）。返回 `(ops_json, updated_at_ms)`。
    pub fn edits_get(&self, path: &str) -> Result<Option<(String, i64)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT ops, updated_at FROM edits WHERE path = ?1")?;
        let mut rows = stmt.query(params![path])?;
        match rows.next()? {
            Some(row) => Ok(Some((row.get(0)?, row.get(1)?))),
            None => Ok(None),
        }
    }

    pub fn edits_set(&self, path: &str, ops: &str) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let now = now_ms();
        conn.execute(
            "INSERT INTO edits (path, ops, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(path) DO UPDATE SET ops=excluded.ops, updated_at=excluded.updated_at",
            params![path, ops, now],
        )?;
        Ok(now)
    }

    pub fn edits_clear(&self, path: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM edits WHERE path = ?1", params![path])?;
        Ok(())
    }

    pub fn status(&self) -> Result<IndexStatus> {
        let conn = self.conn.lock().unwrap();
        let count = |table: &str| -> rusqlite::Result<u64> {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| {
                r.get::<_, i64>(0)
            })
            .map(|v| v as u64)
        };
        let schema: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        Ok(IndexStatus {
            files: count("files")?,
            dirs: count("dirs")?,
            tags: count("tags")?,
            schema,
            bytes: index_bytes(&self.path),
        })
    }
}

fn migrate(conn: &Connection) -> Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version == 0 {
        conn.execute_batch(SCHEMA)?;
        conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
    } else if version > SCHEMA_VERSION {
        return Err(Error::Invalid(format!(
            "索引版本 {version} 高于本程序支持的 {SCHEMA_VERSION}，请升级 Albumio"
        )));
    } else if version < SCHEMA_VERSION {
        // M4 只有 v1；后续版本在这里逐级 ALTER，绝不 DROP 用户数据。
    }
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn index_bytes(path: &Path) -> u64 {
    let main = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let wal = std::fs::metadata(format!("{}-wal", path.display()))
        .map(|m| m.len())
        .unwrap_or(0);
    main + wal
}

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Index(e.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::Index(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meta::{Histogram, MetaSource};

    fn sample(path: &str) -> PhotoMeta {
        PhotoMeta {
            path: path.into(),
            name: "DSC_0482.JPG".into(),
            format: "jpeg".into(),
            width: Some(6000),
            height: Some(4000),
            size: 8_400_000,
            mtime_ns: 1_700_000_000_000_000_000,
            taken_at: 1_731_000_000_000,
            taken_at_text: Some("2024-11-03 16:20".into()),
            taken_source: Some(MetaSource::Exif),
            title: Some("京都夜行".into()),
            title_source: Some(MetaSource::Xmp),
            keywords: vec!["旅行".into(), "京都".into()],
            keywords_source: Some(MetaSource::Xmp),
            rights: None,
            rights_source: None,
            rating: Some(5),
            rating_source: Some(MetaSource::Xmp),
            camera: Some("SONY ILCE-7M4".into()),
            lens: Some("FE 24-70 F2.8".into()),
            exposure: Some("1/125s · f/4.0".into()),
            iso: Some(400),
            focal: Some(35.0),
            orientation: 1,
            orientation_source: Some(MetaSource::Exif),
            gps: None,
            icc: Some("sRGB IEC61966-2.1".into()),
            histogram: Histogram::default(),
        }
    }

    #[test]
    fn upsert_then_read_back_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("index.db");
        {
            let idx = Index::open(&db).unwrap();
            idx.upsert(&sample("C:/pics/a.jpg")).unwrap();
            let st = idx.status().unwrap();
            assert_eq!(st.files, 1);
            assert_eq!(st.schema, SCHEMA_VERSION);
            assert_eq!(idx.add_tag("C:/pics/a.jpg", "京都").unwrap(), vec!["京都"]);
        }
        let idx = Index::open(&db).unwrap();
        let st = idx.status().unwrap();
        assert_eq!(st.files, 1, "重开后数据应保留");
        assert_eq!(idx.tags("C:/pics/a.jpg").unwrap(), vec!["京都"]);
        assert_eq!(
            idx.remove_tag("C:/pics/a.jpg", "京都").unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn deleted_index_recreates_and_does_not_lose_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("index.db");
        let idx = Index::open(&db).unwrap();
        idx.upsert(&sample("C:/pics/a.jpg")).unwrap();
        drop(idx);
        std::fs::remove_file(&db).unwrap();
        // index.db 被删：重新打开就是空库，不报错（folder-first 的硬约束）。
        let idx = Index::open(&db).unwrap();
        assert_eq!(idx.status().unwrap().files, 0);
    }

    #[test]
    fn fts5_search_finds_by_title_and_camera() {
        let dir = tempfile::tempdir().unwrap();
        let idx = Index::open(dir.path().join("index.db")).unwrap();
        idx.upsert(&sample("C:/pics/a.jpg")).unwrap();
        assert_eq!(idx.search("京都夜行", 10).unwrap(), vec!["C:/pics/a.jpg"]);
        assert_eq!(idx.search("SONY", 10).unwrap(), vec!["C:/pics/a.jpg"]);
        assert!(idx.search("不存在的词", 10).unwrap().is_empty());
    }

    #[test]
    fn edits_survive_reopen_and_clear() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("index.db");
        let path = "C:/pics/a.jpg";
        {
            let idx = Index::open(&db).unwrap();
            assert!(idx.edits_get(path).unwrap().is_none());
            idx.edits_set(path, r#"{"v":1,"ops":[{"op":"exposure","ev":0.5}]}"#)
                .unwrap();
        }
        let idx = Index::open(&db).unwrap();
        let (ops, at) = idx.edits_get(path).unwrap().unwrap();
        assert!(ops.contains("\"exposure\""));
        assert!(at > 0);
        idx.edits_clear(path).unwrap();
        assert!(idx.edits_get(path).unwrap().is_none());
    }

    #[test]
    fn future_schema_is_reported_not_silently_accepted() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("index.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch("PRAGMA user_version = 99;").unwrap();
        }
        assert!(Index::open(&db).is_err());
    }
}
