//! Windows 平台解码：HEIC / AVIF / RAW 走系统 WIC（`docs/spike/S2-decoders.md`）。
//!
//! 这三类格式的容器/编码都太重，M5 不引入 libheif / libavif / rawler；改用
//! `Windows Codecs`——HEIF 由「HEIF 图像扩展」提供，AVIF 由「AV1 视频扩展」，
//! RAW 由「Raw Image Extension」。缺少扩展时 WIC 返回 `WINCODEC_ERR_COMPONENTNOTFOUND`，
//! 这里翻译成 `Error::Unsupported`，让界面能说清「缺哪个组件」而不是一句「解码失败」。
//!
//! 已知取舍（验收记录里写明）：
//! - WIC 不给 EXIF Orientation，HEIC 的 `irot` 由编解码器自行处理，这里固定 1；
//! - 不读 ICC（iPhone 的 Display P3 会按 sRGB 处理），色彩校准随 M5 之后的色彩里程碑补；
//! - 全尺寸解码后再缩放，峰值内存 = W×H×4，25MP 的 HEIC 约 100 MB。

use crate::{Error, ImageFormat, Result};
use std::path::Path;
use windows::core::{Interface, HSTRING};
use windows::Win32::Foundation::GENERIC_READ;
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_WICPixelFormat32bppRGBA, IWICBitmapFrameDecode, IWICBitmapSource,
    IWICImagingFactory, IWICPalette, WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom,
    WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};

const WINCODEC_ERR_COMPONENTNOTFOUND: u32 = 0x8898_2F50;
const WINCODEC_ERR_COMPONENTINITIALIZEFAILURE: u32 = 0x8898_2F61;

fn map_err(fmt: ImageFormat, e: windows::core::Error) -> Error {
    let code = e.code().0 as u32;
    if code == WINCODEC_ERR_COMPONENTNOTFOUND || code == WINCODEC_ERR_COMPONENTINITIALIZEFAILURE {
        return Error::Unsupported {
            format: fmt,
            reason: "Windows 缺少该格式的系统图像扩展（HEIF / HEVC / AV1 / Raw Image）".into(),
        };
    }
    Error::Decode(format!("{fmt:?} 解码失败：{e}"))
}

fn open_frame(path: &Path) -> Result<IWICBitmapFrameDecode> {
    let fmt = ImageFormat::Heic; // 仅用于错误信息，调用方会再包一层
    unsafe {
        // 线程池里的每次调用都保证 COM 已初始化；S_FALSE（已初始化）忽略即可。
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| map_err(fmt, e))?;
        let name = HSTRING::from(path.as_os_str().to_string_lossy().as_ref());
        let decoder = factory
            .CreateDecoderFromFilename(&name, None, GENERIC_READ, WICDecodeMetadataCacheOnDemand)
            .map_err(|e| map_err(fmt, e))?;
        decoder.GetFrame(0).map_err(|e| map_err(fmt, e))
    }
}

/// 只取尺寸（相册元数据/状态栏用）；不申请像素缓冲。
pub fn dims(path: &Path) -> Option<(u32, u32)> {
    let frame = open_frame(path).ok()?;
    let mut w = 0u32;
    let mut h = 0u32;
    unsafe { frame.GetSize(&mut w, &mut h).ok()? };
    (w > 0 && h > 0).then_some((w, h))
}

/// 解码为 RGBA8。`_target_edge` 不参与解码：WIC 没有按尺寸解码的通用入口，
/// 缩放交给管线的 fast_image_resize（与 JPEG 的分层解码结果合流）。
pub fn decode_path(
    path: &Path,
    format: ImageFormat,
    _target_edge: Option<u32>,
) -> Result<crate::decode::DecodedImage> {
    let frame = open_frame(path).map_err(|e| match e {
        Error::Unsupported { reason, .. } => Error::Unsupported { format, reason },
        other => other,
    })?;

    unsafe {
        let source: IWICBitmapSource = frame.cast().map_err(|e| map_err(format, e))?;
        let mut w = 0u32;
        let mut h = 0u32;
        source
            .GetSize(&mut w, &mut h)
            .map_err(|e| map_err(format, e))?;
        if w == 0 || h == 0 {
            return Err(Error::Decode(format!("{format:?} 尺寸为 0")));
        }

        // 统一转 RGBA8：HEIC 常见 10bit / YCbCr，直接 CopyPixels 拿到的格式不可控。
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| map_err(format, e))?;
        let converter = factory
            .CreateFormatConverter()
            .map_err(|e| map_err(format, e))?;
        converter
            .Initialize(
                &source,
                &GUID_WICPixelFormat32bppRGBA,
                WICBitmapDitherTypeNone,
                None::<&IWICPalette>,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .map_err(|e| map_err(format, e))?;

        let stride = w as usize * 4;
        let mut rgba = vec![0u8; stride * h as usize];
        converter
            .CopyPixels(std::ptr::null(), stride as u32, &mut rgba)
            .map_err(|e| map_err(format, e))?;

        // 有些 HEIF 编码器给不透明图写全 0 的 alpha；当整张图 alpha 全 0 时按不透明处理。
        if rgba.chunks_exact(4).all(|p| p[3] == 0) {
            for px in rgba.chunks_exact_mut(4) {
                px[3] = 255;
            }
        }

        Ok(crate::decode::DecodedImage {
            format,
            width: w,
            height: h,
            rgba,
            orientation: 1,
            icc: None,
        })
    }
}
