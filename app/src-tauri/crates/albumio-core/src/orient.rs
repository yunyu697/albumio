//! EXIF Orientation 应用（8 种）。

/// 把 Orientation（1..=8）应用到紧凑 RGBA 缓冲，返回应用后的宽高。
pub fn apply_orientation(rgba: Vec<u8>, w: u32, h: u32, orientation: u8) -> (Vec<u8>, u32, u32) {
    if (2..=8).contains(&orientation) {
        let (out, ow, oh) = transform(&rgba, w, h, orientation);
        (out, ow, oh)
    } else {
        (rgba, w, h)
    }
}

fn transform(src: &[u8], w: u32, h: u32, o: u8) -> (Vec<u8>, u32, u32) {
    let (dw, dh) = if matches!(o, 5..=8) { (h, w) } else { (w, h) };
    let mut dst = vec![0u8; src.len()];
    for y in 0..h {
        for x in 0..w {
            // 目标坐标由源坐标按 Orientation 的定义映射而来。
            let (dx, dy) = match o {
                2 => (w - 1 - x, y),                 // 水平镜像
                3 => (w - 1 - x, h - 1 - y),         // 旋转 180°
                4 => (x, h - 1 - y),                 // 垂直镜像
                5 => (y, x),                         // 转置
                6 => (dw - 1 - y, x),                // 顺时针 90°
                7 => (dw - 1 - y, dh - 1 - x),       // 反转置
                8 => (y, dh - 1 - x),                // 逆时针 90°
                _ => (x, y),
            };
            let si = ((y * w + x) * 4) as usize;
            let di = ((dy * dw + dx) * 4) as usize;
            dst[di..di + 4].copy_from_slice(&src[si..si + 4]);
        }
    }
    (dst, dw, dh)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 3×2 的图，像素值等于下标，便于断言映射关系。
    fn sample() -> (Vec<u8>, u32, u32) {
        let w = 3u32;
        let h = 2u32;
        let mut v = vec![0u8; (w * h * 4) as usize];
        for i in 0..(w * h) as usize {
            v[i * 4] = i as u8;
            v[i * 4 + 3] = 255;
        }
        (v, w, h)
    }

    fn rows(v: &[u8], w: u32, h: u32) -> Vec<Vec<u8>> {
        (0..h)
            .map(|y| (0..w).map(|x| v[((y * w + x) * 4) as usize]).collect())
            .collect()
    }

    #[test]
    fn orientation_1_is_identity() {
        let (v, w, h) = sample();
        let (out, ow, oh) = apply_orientation(v.clone(), w, h, 1);
        assert_eq!((ow, oh), (3, 2));
        assert_eq!(out, v);
    }

    #[test]
    fn orientation_2_mirror_horizontal() {
        let (v, w, h) = sample();
        let (out, ow, oh) = apply_orientation(v, w, h, 2);
        assert_eq!((ow, oh), (3, 2));
        assert_eq!(rows(&out, ow, oh), vec![vec![2, 1, 0], vec![5, 4, 3]]);
    }

    #[test]
    fn orientation_3_rotate_180() {
        let (v, w, h) = sample();
        let (out, ow, oh) = apply_orientation(v, w, h, 3);
        assert_eq!(rows(&out, ow, oh), vec![vec![5, 4, 3], vec![2, 1, 0]]);
    }

    #[test]
    fn orientation_4_mirror_vertical() {
        let (v, w, h) = sample();
        let (out, ow, oh) = apply_orientation(v, w, h, 4);
        assert_eq!(rows(&out, ow, oh), vec![vec![3, 4, 5], vec![0, 1, 2]]);
    }

    #[test]
    fn orientation_5_transpose() {
        let (v, w, h) = sample();
        let (out, ow, oh) = apply_orientation(v, w, h, 5);
        assert_eq!((ow, oh), (2, 3));
        assert_eq!(rows(&out, ow, oh), vec![vec![0, 3], vec![1, 4], vec![2, 5]]);
    }

    #[test]
    fn orientation_6_rotate_90_cw() {
        let (v, w, h) = sample();
        let (out, ow, oh) = apply_orientation(v, w, h, 6);
        assert_eq!((ow, oh), (2, 3));
        assert_eq!(rows(&out, ow, oh), vec![vec![3, 0], vec![4, 1], vec![5, 2]]);
    }

    #[test]
    fn orientation_7_transverse() {
        let (v, w, h) = sample();
        let (out, ow, oh) = apply_orientation(v, w, h, 7);
        assert_eq!((ow, oh), (2, 3));
        assert_eq!(rows(&out, ow, oh), vec![vec![5, 2], vec![4, 1], vec![3, 0]]);
    }

    #[test]
    fn orientation_8_rotate_90_ccw() {
        let (v, w, h) = sample();
        let (out, ow, oh) = apply_orientation(v, w, h, 8);
        assert_eq!((ow, oh), (2, 3));
        assert_eq!(rows(&out, ow, oh), vec![vec![2, 5], vec![1, 4], vec![0, 3]]);
    }

    #[test]
    fn out_of_range_is_identity() {
        let (v, w, h) = sample();
        let (out, ow, oh) = apply_orientation(v.clone(), w, h, 0);
        assert_eq!((out, ow, oh), (v, 3, 2));
    }
}
