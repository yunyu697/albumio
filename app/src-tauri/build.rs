fn main() {
    // Windows 专用清单：longPathAware（260 字符路径，R10）+ Common-Controls v6。
    // 非 Windows 平台 tauri-build 会忽略 windows_attributes。
    let windows =
        tauri_build::WindowsAttributes::new().app_manifest(include_str!("windows-app.manifest"));
    let attrs = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attrs).expect("failed to run tauri-build");
}
