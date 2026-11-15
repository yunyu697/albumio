//! Albumio 图像管线地基（04-项目计划 M1）。
//!
//! 固定顺序（`01-方案文档.md` §1.2）：读取 → 魔数探测 → 解码到目标尺寸 →
//! 应用 EXIF Orientation → 色彩转换到 sRGB → 编码 WebP。缩略图永远从原图解码，
//! 不复用上一级缩略图。

pub mod batch;
pub mod cache;
pub mod color;
pub mod decode;
pub mod edit;
pub mod encode;
pub mod icon;
pub mod index;
pub mod listing;
pub mod meta;
pub mod nav;
pub mod ops;
pub mod orient;
pub mod pipeline;
pub mod probe;
pub mod thumb;
pub mod watch;
#[cfg(windows)]
pub mod wic;

pub use batch::{BatchOptions, BatchOutcome, BatchPlan, BatchPlanItem, BatchSource};
pub use cache::{Cache, Level, PIPELINE_VERSION};
pub use decode::DecodedImage;
pub use index::{Index, IndexStatus, SCHEMA_VERSION};
pub use listing::{EntryStat, ListEntry, Listing, Priority};
pub use meta::{Histogram, MetaSource, PhotoMeta};
pub use orient::apply_orientation;
pub use pipeline::{ExportResult, FileInfo, Pipeline, ThumbResult};
pub use probe::ImageFormat;
pub use watch::{Debounce, DirChanges, DirWatcher, WatchEntry, WatchRename};

/// WebView 侧位图的边长硬上限（`docs/spike/S1.md`：16000 可用，20000 构造失败）。
pub const MAX_WEBVIEW_EDGE: u32 = 16384;

/// 管线错误。解码器缺失（HEIC/AVIF/RAW）必须可判定，不允许 UI 静默失败。
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("不是可识别的图片格式：{0}")]
    UnknownFormat(String),
    #[error("{format:?} 解码器不可用：{reason}")]
    Unsupported { format: ImageFormat, reason: String },
    #[error("解码失败：{0}")]
    Decode(String),
    #[error("编码失败：{0}")]
    Encode(String),
    #[error("索引：{0}")]
    Index(String),
    #[error("参数非法：{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, Error>;
