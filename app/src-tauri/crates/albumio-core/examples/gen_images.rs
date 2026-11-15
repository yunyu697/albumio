//! 验收样本生成：写出 N 张真实 JPEG（同一张渐变图编码一次，重复落盘）。
//!
//! 用法：`cargo run --release -p albumio-core --example gen_images -- <目录> <数量> [宽] [高]`
//! 仅用于 M2 的 1 万文件目录验收，不属于产品代码。

use std::io::Cursor;

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = args
        .next()
        .expect("用法：gen_images <目录> <数量> [宽] [高]");
    let count: usize = args
        .next()
        .expect("缺少数量")
        .parse()
        .expect("数量必须是整数");
    let w: u32 = args.next().map(|v| v.parse().unwrap()).unwrap_or(1600);
    let h: u32 = args.next().map(|v| v.parse().unwrap()).unwrap_or(1200);

    let mut img = image::RgbImage::new(w, h);
    for (x, y, p) in img.enumerate_pixels_mut() {
        let fx = x as f32 / w as f32;
        let fy = y as f32 / h as f32;
        *p = image::Rgb([
            (40.0 + 180.0 * fx) as u8,
            (30.0 + 120.0 * fy) as u8,
            (60.0 + 140.0 * (1.0 - fx * fy)) as u8,
        ]);
    }
    let mut bytes = Cursor::new(Vec::new());
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 86)
        .encode_image(&img)
        .expect("JPEG 编码失败");
    let bytes = bytes.into_inner();

    std::fs::create_dir_all(&dir).expect("建目录失败");
    for i in 0..count {
        let name = format!("DSC_{:05}.JPG", i + 1);
        std::fs::write(std::path::Path::new(&dir).join(name), &bytes).expect("写文件失败");
    }
    println!(
        "已生成 {count} 张 {w}×{h} JPEG（{} KB/张）：{dir}",
        bytes.len() / 1024
    );
}
