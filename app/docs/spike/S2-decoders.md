# HEIC / AVIF / RAW 解码器评估（M5 硬前置 · 对应 S2 的 Windows 部分）

- 目标：给 M5 开工一个明确结论——三种格式各走哪条解码路径、内存与耗时量级、包体积与静态链接代价、失败时怎么降级。**本文只评估，不接入代码。**
- 依据：`04-项目计划.md` §2 S2（三平台 HEIC 可用性）、M1 交付里的格式清单、`app/docs/acceptance/M1.md` §7「HEIC/AVIF/RAW 未接入」。
- 实测环境：Windows 11 · i9-9900K · 本地 NTFS SSD · 通过 PowerShell + WPF（底层即 WIC）测平台 codec；样本：`example.heic`（1280×854，701 KB，libheif 仓库）、`big.heic`（1440×960，0.28 MB，filesamples）、`fox.avif`（1204×800，79 KB，link-u 样本库）、自造 4000×3000 JPEG（939 KB）。
- **限制在前**：macOS / Linux 未实测（本机无环境）；libheif / dav1d / rawler / LibRaw 均**未在本机编译**，它们的耗时与体积是「文档 + 包体数据 + 同类库经验」的量级估算，接入时必须用固定样本复测。

## 1. 结论（先说答案）

1. **M5 先走平台 codec（WIC），把解码器抽成 trait，不现在引入 C 依赖。** 本机 Windows 上 HEIC / AVIF / RAW 三个扩展都在（见 §2），单张打开与缩略图都能跑通；这一步的包体积代价是 0。
2. **HEIC 的内置兜底留到 M9 打包前决策**（S2 的三平台矩阵出结论时）。理由是 WIC 的 HEIC 依赖 **HEVC 扩展（非系统自带、可能需付费/随 OEM）**，不能保证每台机器都有；引入 `libheif + libde265` 的代价是约 **+1.1 MB** 与一条 vcpkg/cmake 构建链。计划 R1 预留的「+6–8 MB」是含编码器（x265/libaom）的数字，**只做解码约 +2.5–4 MB**。
3. **AVIF 有一个必须写进 M5 验收的已知风险**：AVIF 普遍没有可用的内嵌缩略图，网格 L1 必须全解码。按实测 50–65 ms/MP（WIC）与 dav1d 估算的 10–20 ms/MP，12 MP 一张要 100–800 ms，48 格首屏不可能落在 800 ms 内。结论：**AVIF 的网格缩略图用占位 + 后台补图，首屏 800 ms 预算只对 JPEG/PNG/HEIC 生效**，AVIF 单张打开仍按 M5 目标验。
4. **RAW 的计划假设要更正**：`rawler` 0.6/0.8 的公开 API **只能取原始像素与元数据，没有内嵌预览/缩略图提取**（docs.rs 全量条目里没有 preview/thumbnail）。「rawler 只取内嵌预览」这条目前做不到，需要自己解析 TIFF/EXIF 预览（CR2/NEF/ARW/DNG），或改用 LibRaw 的 `unpack_thumb`（+2.3 MB）。**建议自研预览抽取，CR3 列为已知缺口。**
5. 无论走哪条路，解码结果都必须回到现有管线：**Rust 侧 EXIF 方向 + lcms2 → sRGB → WebP**，不把 ICC/方向交给 WebView 或系统 codec 的默认行为。

## 2. 平台 codec（WIC）实测

本机已安装（`Get-AppxPackage`）：

| 扩展 | 版本 | 作用 |
| --- | --- | --- |
| `Microsoft.HEIFImageExtension` | 1.2.62.0 | HEIC 容器 |
| `Microsoft.HEVCVideoExtension` | 2.5.48.0 | HEIC 的 HEVC 码流（**可能付费/缺失**） |
| `Microsoft.AV1VideoExtension` | 2.0.35.0 | AVIF |
| `Microsoft.RawImageExtension` | 2.5.42.0 | 相机 RAW |

实测（WPF `BitmapDecoder` → `FormatConvertedBitmap` → `CopyPixels`；同进程已预热，文件名唯一以避免缓存）：

| 样本 | 全解码 | 内嵌缩略图 | 冷启动首调用 |
| --- | --- | --- | --- |
| `example.heic` 1280×854（1.1 MP） | 135 / 146 / 199 ms（三次） | 23 / 27 / 40 ms（320×212） | 1352 ms |
| `big.heic` 1440×960（1.4 MP） | 660 ms（新进程首调用，含冷启动） | 8.6 ms（240×160） | — |
| `fox.avif` 1204×800（1.0 MP） | 50 / 51 / 65 ms | 29 / 39 / 69 ms（**75×50，太小**） | 424 ms |
| 自造 JPEG 4000×3000（12 MP） | 114 ms | 无 | — |

读法：

- **缩略图是 HEIC 在网格里的正确入口**：320×212 的 23–40 ms 可以做 L1（≤256 长边），不必全解码；但 48 格 × 30 ms 单线程仍要 1.4 s，必须多线程（4 线程约 350 ms）。
- **HEIC 全解码明显偏慢**：1.1 MP 要 135–199 ms，按线性外推 12 MP 约 1.5 s；`big.heic` 的 660 ms 里还含每次进程的扩展初始化。这决定了 HEIC 的 L0/L1 不能靠全解码 + 缩放。
- **AVIF 的内嵌缩略图不可依赖**：样本里的 75×50 只能做占位，不能做 L1。
- WIC 的 `BitmapDecoder.Create` 首调用有 0.4–1.4 s 的一次性扩展加载；常驻进程只付一次，但「应用启动后第一次看 HEIC」会明显偏慢，需要预加载或骨架屏。
- WIC 没有「按目标尺寸解码」：HEIC/AVIF 只能全解码后再缩放（或用 HEIC 自带缩略图），内存峰值就是全图。

## 3. 可选库对比

| 格式 | 方案 | 版本 / 许可证 | Windows 构建要求 | 能力 | 备注 |
| --- | --- | --- | --- | --- | --- |
| HEIC | **WIC**（系统） | OS 组件 | 无 | 全解码、内嵌缩略图、EXIF | 依赖 HEIF + HEVC 扩展；缺失即失败；解码行为随系统版本变 |
| HEIC | **libheif-rs + libde265** | 3.0.0 / libheif LGPL-3.0 + MIT、libde265 LGPL-3.0 | **vcpkg**（README 明确 Windows 用 vcpkg；`embedded-libheif` 只静态编 libheif，libde265 仍是动态） | 全解码、`thumbnail_images()`、可读 EXIF、可控缩放 | 需 libheif ≥ 1.17；1.19+ 的插件式 codec 需在构建时编进去，避免运行时 dlopen |
| AVIF | **WIC**（系统） | OS 组件 | 无 | 全解码、少量缩略图 | 依赖 AV1 扩展；实测速度一般 |
| AVIF | **`image` 的 `avif-native`（dav1d）** | dav1d 0.11.1 / BSD-2-Clause | **meson + ninja + nasm**（本机都没有） | 全解码，多线程 | image 0.25 的 `avif-native = mp4parse + dav1d`；`avif` feature 是编码器（ravif），不要混淆 |
| AVIF | **libheif + dav1d/aom** | 同上 | vcpkg（默认 `aom` feature）或自建 dav1d | 全解码 | vcpkg 的 libheif 只提供 `aom` 做 AVIF；用 dav1d 要自己编，且避免与 image 的 dav1d 重复链接 |
| RAW | **WIC RawImage** | OS 组件 | 无 | 全解码（含去马赛克） | 慢；依赖扩展；无「只取预览」接口 |
| RAW | **rawler** | 0.6.0（最新 0.8.0）/ LGPL-2.1 | 纯 Rust，无 C 依赖 | 原始像素 + 元数据，**无预览 API** | 不做去马赛克，输出 CFA 原始数据；网格用不了 |
| RAW | **LibRaw** | 0.20 / LGPL-2.1 或 CDDL-1.0 | vcpkg / cmake | `unpack_thumb()` 取内嵌 JPEG，全解码 | 预览路径最省事，代价 +2.3 MB 与 LGPL 义务 |
| RAW | **自研 TIFF 预览抽取** | 无新依赖 | 无 | CR2/NEF/ARW/DNG 的内嵌 JPEG | 需要逐格式处理 MakerNote/SubIFD；CR3（BMFF）另算 |

## 4. 内存与耗时量级

内存按「一张图在解码期同时存在的像素缓冲」估算（不含缓存）：

| 场景 | 缓冲 | 量级 |
| --- | --- | --- |
| 12 MP 全解码 → RGBA | W×H×4 | **48 MB** |
| 45 MP 全解码 → RGBA | W×H×4 | **180 MB** |
| HEIC/AVIF 12 MP 10-bit 4:2:0 中间层 | 1.5 × 2 B/px | **36 MB**（之后再加 48 MB RGBA） |
| HEIC 内嵌缩略图 320×212 | W×H×4 | **0.26 MB** |
| RAW 45 MP 14-bit（u16 单平面） | W×H×2 | **90 MB**，去马赛克后再 ×3 |
| RAW 内嵌预览 JPEG（典型 2–5 MB） | 解码后约 1–2 MP | **4–8 MB** |

耗时量级（实测为 WIC；其余为估算，接入时复测）：

| 格式 | 缩略图 | 12 MP 全解码 |
| --- | --- | --- |
| JPEG（现有管线，1/8 DC） | 1.3 ms | 同左（DC 直读） |
| HEIC（WIC，缩略图可用） | 9–40 ms | ~1.5 s（1.1 MP 实测 135–199 ms 外推） |
| HEIC（libheif + libde265） | 5–15 ms（估） | 100–250 ms（估，多线程） |
| AVIF（WIC） | 29–69 ms，但只有 75×50 | 600–800 ms（50–65 ms/MP 外推） |
| AVIF（dav1d） | 无可用缩略图 | 100–200 ms（估，多线程） |
| RAW（LibRaw 预览） | 5–20 ms（估） | 全解码 1.5–4 s（估） |
| RAW（rawler） | 无预览 | 0.5–2 s，且只是 CFA，不能直接显示 |

## 5. 包体积与静态链接影响

包体数据取自 Debian amd64 的「Installed Size」（.so 量级，Windows 静态链接通常相当或略大）：

| 库 | 体积 | 许可证 | 说明 |
| --- | --- | --- | --- |
| libheif | 0.66 MB | LGPL-3.0 + MIT | 1.15.1；1.23 略大，约 0.7–1 MB |
| libde265 | 0.47 MB | LGPL-3.0 | HEIC 解码必需 |
| libdav1d | 1.6 MB | BSD-2-Clause | AVIF 解码；x86-64 SIMD 全开 |
| LibRaw | 2.3 MB | LGPL-2.1 / CDDL-1.0 | 还带 libjpeg-turbo、lcms2 依赖（lcms2 我们已有） |
| rawler | 0.3–0.6 MB（估） | LGPL-2.1 | 纯 Rust，无 C 依赖 |
| WIC | 0 | OS 组件 | 不进安装包 |

组合起来的现实体积：

- **方案 A（WIC 为主）**：+0 MB。代价是覆盖率与性能（见 §6）。
- **方案 B（libheif+libde265 + dav1d，含 RAW 自研预览）**：约 **+2.5–3.2 MB**（解码器静态裁剪后；不含 x265/aom 编码器）。
- **方案 C（在 B 上加 LibRaw 做 RAW 预览）**：约 **+4.5–5.5 MB**。
- 计划 R1 写的「+6–8 MB」偏保守，主要差在把 x265/libaom 这类编码器算进去了；只做解码用不到。

静态链接的实际影响（比体积更麻烦）：

1. **Windows 构建链**：`libheif-rs` 在 Windows 上走 vcpkg；本机 **没有 cmake**，`embedded-libheif` 也要求 cmake，且只静态编 libheif 自身，libde265 仍是动态库。要做到「单 exe 自包含」，得用 vcpkg 的 static triplet 把 libde265 一起静态编。
2. **dav1d 需要 meson + ninja + nasm**，本机三者都没有。启用 `image/avif-native` 会让 Windows CI 多一套工具链；更稳的做法是在 CI 里预编译 dav1d 静态库并缓存。
3. **LGPL 义务**：libheif、libde265、rawler 都是 LGPL。静态链接要求向用户提供可重新链接的目标文件；**随包附带 DLL**（`libheif.dll`、`libde265.dll`）是更省事且常见的合规做法，安装包体积与静态接近。
4. **不要链接两个 dav1d**：libheif 若带 dav1d 插件，`image/avif-native` 再带一份就会重复。二选一，统一从 libheif 解码 HEIC+AVIF，或 AVIF 单独走 image。
5. 速度与体积的取舍：vcpkg 的 libheif 默认用 `aom` 做 AVIF（+2–3 MB、比 dav1d 慢数倍）；用 dav1d 需要自建。若选「libheif 通吃」，要么接受 aom 的体积/速度，要么维护一条自建 dav1d 的构建。

## 6. 失败与降级路径

| 情况 | 行为 |
| --- | --- |
| WIC 缺 HEIF / HEVC / AV1 / RawImage 扩展 | 捕获 `WINCODEC_ERR_COMPONENTNOTFOUND` 一类失败 → 若有内置库则转内置；否则该文件显示「此格式需要系统组件」占位，详情面板给 Microsoft Store 链接；**不影响同目录其它文件** |
| HEIC 无内嵌缩略图 / 缩略图 < 128 px | 全解码后缩放；内存 +48 MB、时间 +100–200 ms，任务降级到后台队列 |
| AVIF 无内嵌缩略图（常态） | 网格先占位，后台全解码后补 L1；限并发（建议 4），不阻塞首屏 |
| libheif 不支持的 profile（10-bit / 4:4:4 / AVIF-in-HEIF） | 回退 WIC；仍失败则占位 + 「无法解码」 |
| RAW 没有内嵌预览（CR3 等） | 占位 + 元数据照常显示（相机/镜头/ISO 来自 rawler）；查看器提示「暂无预览」 |
| 解码超时（>3 s）或内存超限 | 取消该任务 + 占位，不拖垮队列；同时只允许 1 个全尺寸解码在跑 |
| 文件损坏 / 截断 | 返回占位 + 日志；不重试超过 1 次 |

## 7. 推荐与代价

**推荐：方案 A 起步，接口按方案 B 预留。**

| 阶段 | 做法 | 代价 |
| --- | --- | --- |
| M5（现在） | 解码器抽成 `Decoder` trait：`probe` / `thumbnail` / `decode_scaled` / `decode_full`；Windows 实现走 WIC（HEIC 优先取内嵌缩略图，AVIF 全解码，RAW 先占位）；无扩展时返回可识别的「缺组件」错误 | +0 MB；需要 `windows` crate 的 WIC 绑定；AVIF 网格慢（已知风险写入验收） |
| M5 同期（可选） | RAW 内嵌预览抽取（自研 TIFF/EXIF 读取，覆盖 CR2/NEF/ARW/DNG），让 RAW 在网格里可用 | 纯 Rust，无新依赖；CR3 列为缺口 |
| M9 前（S2 出矩阵后） | 若目标用户可能缺 HEVC 扩展 → 内置 `libheif + libde265` 作为 HEIC 兜底 | +1.1 MB（DLL 形式）或 +3 MB（全静态）+ vcpkg/cmake；LGPL 合规按 DLL 走 |
| 视 AVIF 性能再定 | 若 AVIF 用户占比高、600–800 ms 不可接受 → 引入 dav1d（`image/avif-native` 或 libheif 自建） | +1.6 MB + meson/nasm 构建链 |
| 不推荐现在做 | LibRaw 全量接入（+2.3 MB、LGPL/CDDL、OpenMP 依赖）；RAW 全解码展示 | 收益只在「没有内嵌预览的 RAW」，先用占位更划算 |

一句话代价总结：**M5 用 WIC 是 0 包体、0 新构建链，换来的是「依赖用户机器上的扩展」与 AVIF 网格偏慢；要消除这两个代价，需要 +1–3 MB 包体、一条 vcpkg/cmake（必要时再加 meson/nasm）构建链，以及 LGPL 的动态链接合规。**

## 8. 对 M5 验收的直接影响

1. 固定样本里的 **25 MB HEIC**：用内嵌缩略图做 L0/L1，用全解码做 L2；WIC 路径在本机可过，但首次打开要计入扩展冷启动（0.4–1.4 s），建议应用启动时预热一次解码器。
2. **AVIF 不进「首屏 48 格 ≤800 ms」的判定**，单独记一条「AVIF L1 为后台补图，首屏允许占位」。
3. **RAW 在 M5 只保证「元数据 + 网格占位」**；预览抽取做完再提升为「网格可显示」。
4. 三种格式都要过同一套色彩与方向校验：解码后先应用 EXIF 方向，再 lcms2 → sRGB，禁止依赖系统 codec 的自动旋转/ICC。

## 9. 未验证 / 待补

- macOS（ImageIO）与 Linux（libheif / 无系统 codec）未实测，S2 的三平台矩阵仍缺两格。
- 10-bit HDR HEIC、4:4:4 HEIC、AVIF 的 12-bit 样本未测。
- CR3 的内嵌预览结构未验证。
- libheif / dav1d / LibRaw 的 Windows 编译与真实耗时未测；本文的体积与耗时是量级估算，接入时用固定样本复测并回填本表。
- WIC 的 HEIC 解码在不同 Windows 版本/扩展版本下行为可能不同，需要至少在 Win10 22H2 与 Win11 各测一次。
