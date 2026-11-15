//! 色彩：把带 ICC 的像素一次性转到 sRGB（`01-方案文档.md` §1.2，只做一次）。

use crate::{Error, Result};
use lcms2::{Intent, PixelFormat, Profile, Transform};

/// 有 ICC 且不是 sRGB 时原地转换；返回是否真的转换过。
pub fn to_srgb(rgba: &mut [u8], icc: Option<&[u8]>) -> Result<bool> {
    let Some(icc) = icc else { return Ok(false) };
    if rgba.is_empty() || rgba.len() % 4 != 0 {
        return Err(Error::Invalid("RGBA 缓冲长度不是 4 的整数倍".into()));
    }
    let src = Profile::new_icc(icc).map_err(|e| Error::Decode(format!("ICC 解析失败：{e}")))?;
    let dst = Profile::new_srgb();
    let transform: Transform<u8, u8> = Transform::new(
        &src,
        PixelFormat::RGBA_8,
        &dst,
        PixelFormat::RGBA_8,
        Intent::Perceptual,
    )
    .map_err(|e| Error::Decode(format!("ICC 转换创建失败：{e}")))?;
    transform.transform_in_place(rgba);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_profile_is_noop() {
        let mut px = vec![10, 20, 30, 255];
        assert!(!to_srgb(&mut px, None).unwrap());
        assert_eq!(px, vec![10, 20, 30, 255]);
    }

    #[test]
    fn broken_profile_is_an_error_not_a_panic() {
        let mut px = vec![0u8; 4];
        assert!(to_srgb(&mut px, Some(b"not an icc profile")).is_err());
    }

    #[test]
    fn display_p3_red_differs_after_conversion() {
        use lcms2::{CIExyY, CIExyYTRIPLE, ToneCurve};
        let d65 = CIExyY {
            x: 0.3127,
            y: 0.3290,
            Y: 1.0,
        };
        let p3 = CIExyYTRIPLE {
            Red: CIExyY {
                x: 0.680,
                y: 0.320,
                Y: 1.0,
            },
            Green: CIExyY {
                x: 0.265,
                y: 0.690,
                Y: 1.0,
            },
            Blue: CIExyY {
                x: 0.150,
                y: 0.060,
                Y: 1.0,
            },
        };
        let curve = ToneCurve::new(2.2);
        let profile = Profile::new_rgb(&d65, &p3, &[&curve, &curve, &curve]).unwrap();
        let icc = profile.icc().unwrap();

        // 纯绿在 sRGB 里被裁到边界（这是正确的过饱和处理）。
        let mut pure_green = vec![0u8, 255, 0, 255];
        to_srgb(&mut pure_green, Some(&icc)).unwrap();
        assert_eq!(pure_green[3], 255);
        assert!(pure_green[1] > 200 && pure_green[0] < 120);

        // 中间调必须真的动（P3 的色域比 sRGB 大，同一组数值不等于同一颜色）。
        let mut mid = vec![200u8, 100, 50, 255];
        to_srgb(&mut mid, Some(&icc)).unwrap();
        assert_ne!(mid[..3], [200, 100, 50], "P3 中间调未做转换");
        assert!(mid[0] > 200 && mid[2] < 50, "置换方向不对：{mid:?}");
    }
}
