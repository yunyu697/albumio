# 程序图标：资源、生成与平台切换结论

界面内图标（`design/icon-registry.json` 与 `design-system/tools/check-icons.mjs`）与本文的程序图标是两套东西，不互相登记、不共用校验。

## 1. 矢量源

| 文件 | 用途 |
| --- | --- |
| `design/assets/app-icon/albumio-light.svg` | 浅色底那一张（512×512，圆角 rx 114） |
| `design/assets/app-icon/albumio-dark.svg` | 暗色底那一张（同尺寸同圆角） |

改图形只改这两份 SVG，然后重跑第 2 节的命令重新生成位图；不要直接改 `icons/` 下的 png。

## 2. 生成命令与产物

```bash
# 打包用全套（暗色那张）
npx tauri icon design/assets/app-icon/albumio-dark.svg -o app/src-tauri/icons
# 运行时切换用的 256 px（亮色）
npx tauri icon design/assets/app-icon/albumio-light.svg -o app/src-tauri/icons-light
```

- `app/src-tauri/icons/`：`32x32.png` `64x64.png` `128x128.png` `128x128@2x.png` `icon.png`(512) `icon.ico` `icon.icns` `Square*Logo.png` `StoreLogo.png`。`android/` `ios/` 已删除（本项目不做移动端）。移动端目录如被重新生成，直接删掉。
- `icon.ico` 内含 16/24/32/48/64/256 六档 32bpp，供 exe 资源与 MSI/NSIS 快捷方式使用。
- `icon.icns` 含 16–1024 的 ic07/ic08/ic09/ic10/ic11/ic12/ic13/ic14 与旧式 32bpp 条目。
- `icons/theme/light-256.png`、`icons/theme/dark-256.png`：从上面两套里抽出的 256 px，编译期用 `include_bytes!` 嵌进二进制（各约 19–21 KB）。
- `tauri.conf.json` 的 `bundle.icon` 指向 `icons/` 下那一套（暗色）。

## 3. 分平台结论

| 平台 / 位置 | 能否随系统明暗切换 | 手段 | 本项目最终用哪张 |
| --- | --- | --- | --- |
| Windows 窗口与任务栏图标（运行中） | **能，运行时** | `window.set_icon(Image)` → `WM_SETICON`；`WindowEvent::ThemeChanged` 收到主题变化后重设，启动时按 `window.theme()` 先设一次 | 跟随系统：浅色模式用 light，暗色模式用 dark |
| Windows exe 资源 / 快捷方式 / 开始菜单 / 文件关联 | **不能** | 图标在构建时烧进 `icon.ico`，快捷方式存的是 exe 的静态图标 | dark（安装包与快捷方式恒为暗色那张） |
| macOS Dock（运行中） | **能，但要自己写 objc** | `NSApplication.setApplicationIconImage:`；Tauri/tao 未封装，`window.set_icon` 在 macOS 是空实现（`tao-0.37.2/src/platform_impl/macos/window.rs:1367`） | 不切，用 dark |
| macOS Dock / Finder / Launchpad / Spotlight（未运行或从 Finder 启动） | **不能** | 只有 bundle 里的 `icon.icns` 一个来源，macOS 没有"按外观选图标"的机制（模板图只对菜单栏成立） | dark |
| Linux 窗口图标（X11） | 能，运行时 | `set_icon` → GTK `gtk_window_set_icon` → `_NET_WM_ICON`；但多数桌面把任务栏条目绑定到 `.desktop` 的 `Icon=`，窗口图标只在部分窗口管理器里可见 | 不切，用 dark |
| Linux 窗口图标（Wayland） | **不能** | GTK 的 `set_icon` 在 Wayland 下没有对应协议，调用无效 | dark |
| Linux `.desktop` 桌面入口 / Dock | **不能** | 安装时写入固定图标名，指向 `hicolor` 下的 png 集；不随主题选图 | dark |

结论：**只有 Windows 的运行中窗口/任务栏图标真正跟系统明暗走**，其余全部用暗色那张。安装包与快捷方式层面的图标在三平台都是静态的，不随主题变化——Windows 快捷方式、macOS `.app`、Linux `.desktop` 都一样。

## 4. 定稿结论（已拍板）

| 平台 | 用哪张 | 依据 |
| --- | --- | --- |
| Windows 运行中的窗口与任务栏图标 | 明暗两套都收，跟随系统 | 唯一有干净运行时接口的平台：`set_icon` 直接改窗口图标，`ThemeChanged` 又能可靠触发；成本只有两张 256px png 和一次 `WM_SETICON` |
| Windows exe / 快捷方式 / 开始菜单 / 文件关联 | 暗色 | 这些位置的图标是构建期烧进 exe 资源、快捷方式里存的是静态引用，没有按主题换图的机制 |
| macOS Dock、Finder、Launchpad | 暗色，不做运行时切换 | 运行时切换只能自己调 `NSApplication.setApplicationIconImage:`（Tauri/tao 未封装，tao 的 macOS `set_window_icon` 是空实现），要为此引入 objc 绑定；收益只是"运行中改主题后 Dock 跟着变"，且没有 macOS 实机可验，不划算。未运行时的图标本来就只认 bundle 里的 icns，没有明暗两套的机制 |
| Linux 窗口图标与 `.desktop` 桌面入口 | 暗色 | X11 下 `set_icon` 只改 `_NET_WM_ICON`，任务栏/Dock 条目走 `.desktop` 的固定图标名；Wayland 下 `set_icon` 没有对应协议、调用无效。两处都拿不到"跟随系统外观"的语义，做运行时切换也只能切到一半 |

一句话：**运行时跟主题只在 Windows 生效；三个平台的安装包、快捷方式、桌面入口一律暗色**。
