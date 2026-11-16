# 构建 Win11 右键菜单的 MSIX sparse 包（M9）。
#
#   pwsh -File build.ps1
#
# 产物：build\AlbumioShell.msix（未签名）与 build\pkg\（供安装器把 DLL 放到 albumio.exe 旁边）。
# 标识（包名 / Publisher / CLSID）只来自 identity.json；改标识就改那一个文件。
# 需要 MSVC（cl.exe）与 Windows SDK 的 MakeAppx.exe；缺任何一个都会明确报错退出。

param(
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$build = Join-Path $root "build"
$pkg = Join-Path $build "pkg"
$bin = Join-Path $build "bin"
$gen = Join-Path $build "generated"
$assets = Join-Path $pkg "Assets"

$identity = Get-Content (Join-Path $root "identity.json") -Raw -Encoding utf8 | ConvertFrom-Json
$icons = Join-Path (Split-Path $root -Parent) "src-tauri\icons"

function Write-Utf8NoBom([string]$path, [string]$text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Find-VcVars {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        if ($vs) {
            $candidate = Join-Path $vs "VC\Auxiliary\Build\vcvars64.bat"
            if (Test-Path $candidate) { return $candidate }
        }
    }
    $patterns = @(
        "${env:ProgramFiles}\Microsoft Visual Studio\*\*\VC\Auxiliary\Build\vcvars64.bat",
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\*\*\VC\Auxiliary\Build\vcvars64.bat"
    )
    foreach ($pattern in $patterns) {
        $hit = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

function Find-MakeAppx {
    $patterns = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\MakeAppx.exe",
        "${env:ProgramFiles}\Windows Kits\10\bin\*\x64\MakeAppx.exe"
    )
    $found = @()
    foreach ($pattern in $patterns) {
        $found += Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue
    }
    return ($found | Sort-Object FullName -Descending | Select-Object -First 1).FullName
}

# 1. 生成 CLSID 头与清单（标识只在这里被展开）
foreach ($dir in @($gen, $pkg, $bin)) {
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
}
New-Item -ItemType Directory -Force -Path $gen, $pkg, $assets, $bin | Out-Null

$guidParts = $identity.clsid -split '-'
if ($guidParts.Count -ne 5) { throw "identity.json 的 clsid 不是标准 GUID：$($identity.clsid)" }
$clsidHeader = @"
// 由 build.ps1 从 identity.json 生成，不要手改。
#pragma once
#define ALBUMIO_SHELL_CLSID {0x$($guidParts[0]),0x$($guidParts[1]),0x$($guidParts[2]),{0x$($guidParts[3].Substring(0,2)),0x$($guidParts[3].Substring(2,2)),0x$($guidParts[4].Substring(0,2)),0x$($guidParts[4].Substring(2,2)),0x$($guidParts[4].Substring(4,2)),0x$($guidParts[4].Substring(6,2)),0x$($guidParts[4].Substring(8,2)),0x$($guidParts[4].Substring(10,2))}}
#define ALBUMIO_APP_EXE L"$($identity.executable)"
"@
Write-Utf8NoBom (Join-Path $gen "clsid.h") $clsidHeader

$manifest = Get-Content (Join-Path $root "AppxManifest.template.xml") -Raw -Encoding utf8
$tokens = @{
    "@PACKAGE_NAME@"          = $identity.packageName
    "@PUBLISHER@"             = $identity.publisher
    "@PUBLISHER_DISPLAY_NAME@" = $identity.publisherDisplayName
    "@DISPLAY_NAME@"          = $identity.displayName
    "@VERSION@"               = $identity.version
    "@APPLICATION_ID@"        = $identity.applicationId
    "@VERB_ID@"               = $identity.verbId
    "@EXECUTABLE@"            = $identity.executable
    "@DLL@"                   = $identity.dllName
    # 这个 SDK 的清单 schema 里 com:Class/@Id 与 Verb/@Clsid 都要求不带花括号的 GUID。
    "@CLSID_BARE@"            = $identity.clsid
    "@CLSID@"                 = $identity.clsid
}
foreach ($key in $tokens.Keys) { $manifest = $manifest.Replace($key, $tokens[$key]) }
Write-Utf8NoBom (Join-Path $pkg "AppxManifest.xml") $manifest

# 2. 资源图标：直接用应用自己的图标，避免两套品牌资产
foreach ($name in @("Square44x44Logo.png", "Square150x150Logo.png", "StoreLogo.png")) {
    Copy-Item (Join-Path $icons $name) (Join-Path $assets $name) -Force
}

# 3. 编译 COM DLL
$vcvars = Find-VcVars
if (-not $vcvars) {
    throw "找不到 MSVC（vcvars64.bat）。请安装 Visual Studio 的 [使用 C++ 的桌面开发] 工作负载。"
}

$sources = (Get-ChildItem (Join-Path $root "src") -Filter *.cpp | ForEach-Object { "`"$($_.FullName)`"" }) -join " "
$bat = @"
@echo off
call "$vcvars" >nul
if errorlevel 1 exit /b 1
cd /d "$bin"
cl /nologo /LD /EHsc /O2 /utf-8 /DUNICODE /D_UNICODE /I"$gen" $sources /Fe:"$bin\$($identity.dllName)" /link /DEF:"$root\albumio_shell.def" ole32.lib shell32.lib user32.lib
exit /b %ERRORLEVEL%
"@
$batPath = Join-Path $build "compile.bat"
Write-Utf8NoBom $batPath $bat

Write-Host "编译 $($identity.dllName) ..."
& cmd.exe /c "`"$batPath`""
if ($LASTEXITCODE -ne 0) { throw "cl.exe 编译失败（退出码 $LASTEXITCODE）" }

# 4. 打包（未签名；签名用用户证书，见结尾提示）
$makeappx = Find-MakeAppx
if (-not $makeappx) {
    throw "找不到 MakeAppx.exe。请安装 Windows SDK（10.0.22000 及以上）。"
}

$out = Join-Path $build "AlbumioShell.msix"
Write-Host "打包 $out ..."
# /nv：sparse 包的应用本体在包外（-ExternalLocation），跳过"清单引用的文件必须在包内"的体检。
& $makeappx pack /d $pkg /p $out /o /nv
if ($LASTEXITCODE -ne 0) { throw "MakeAppx 失败（退出码 $LASTEXITCODE）" }

Write-Host ""
Write-Host "完成（未签名，按约定不把证书当交付前置）："
Write-Host "  $out"
Write-Host "  $bin\$($identity.dllName)"
Write-Host "包内容："
Get-ChildItem $pkg -Recurse -File | ForEach-Object { Write-Host "  $($_.FullName.Substring($pkg.Length + 1))" }
Write-Host ""
Write-Host "后续（需用户证书与真机）："
Write-Host "  1) signtool sign /fd SHA256 /a /f <证书.pfx> /p <密码> `"$out`""
Write-Host "  2) 把 $($identity.dllName) 与 albumio.exe 放在同一目录（安装器负责）"
Write-Host "  3) Add-AppxPackage -Path `"$out`" -ExternalLocation `"<albumio.exe 所在目录>`""
