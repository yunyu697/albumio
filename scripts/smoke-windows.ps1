# 启动冒烟（Windows）：进程必须起得来、窗口必须响应、缩略图流水线必须真的跑通。
#
# 为什么是这三条：RC5 的 Windows 包窗口能起来（WebView2 子进程都在），但主线程被
# 目录列举的死循环占死，表现是「窗口未响应 + 单核 100%」；只看进程是否存活、只看
# 有没有白屏都抓不到。所以这里同时断言：
#   1. 进程在超时时间内没有提前退出；
#   2. 主窗口出现并且 Responding=True（窗口消息循环在转）；
#   3. 缩略图缓存目录有新增文件（前端真的跑起来了：列举 → stat → 缩略图整条链路）。
#
# 失败时按三类明确报出，避免把「窗口无响应」和「流水线没产出」混成一个错：
#   window-unresponsive / pipeline-no-output / exited-early
#
# 用法（本地或 CI）：
#   pwsh -File scripts/smoke-windows.ps1 -Exe app/src-tauri/target/release/albumio.exe
# 可选：-TimeoutSec 60  -MinThumbs 1  -ThumbsDir <目录>  -KeepWorkDir

param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [int]$TimeoutSec = 60,
    [int]$MinThumbs = 1,
    [string]$ThumbsDir = (Join-Path $env:APPDATA 'albumio\thumbs'),
    [switch]$KeepWorkDir
)

$ErrorActionPreference = 'Stop'

function Fail([string]$kind, [string]$message) {
    Write-Host "SMOKE FAIL $kind`: $message"
    exit 1
}

if (-not (Test-Path -LiteralPath $Exe)) {
    Fail 'bad-args' "找不到可执行文件：$Exe"
}

# 单实例插件会把启动参数转给已运行的实例然后自己退出，冒烟必须在干净环境里跑。
$running = @(Get-Process -Name 'albumio' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    $ids = ($running | ForEach-Object { $_.Id }) -join ','
    Fail 'env-dirty' "已有 albumio 实例在运行（PID $ids），单实例会把参数转给它，冒烟结果不可信"
}

# 造一个只含图片的临时目录：路径每次唯一，缩略图缓存 key 含路径，必然全部未命中。
# 文件名刻意覆盖真实场景里的两类形状：
#   - 「共同前缀 + 两段数字」（截图/相机导出，RC5 死循环的触发条件）；
#   - 前导零与普通序号（自然序比较器的收敛边界）。
# 只用 smoke_01.png 这种名字的话，RC5 那类回归会漏过去（实测过：RC5 装包能 PASS）。
$names = @(
    'Snipaste_2025-03-09_12-45-53.png',
    'Snipaste_2025-03-09_12-51-25.png',
    'Snipaste_2025-03-20_21-28-43.png',
    'IMG_01.png',
    'IMG_1.png',
    'DSC_2.png',
    'DSC_10.png',
    'plain.png'
)
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("albumio-smoke-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$png = [Convert]::FromBase64String(
    'iVBORw0KGgoAAAANSUhEUgAAAIAAAABgCAIAAABaGO0eAAAAoklEQVR42u3RQQ0AIBDAsB3gXzMmSPg0mYJ1qtXoV6c9pW8BAADABQAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAACAEAAAAgAAAEAIAAABACAAAAQAAACAEAAAAgAAAAAAAAwAgAAAQAgAAAEAIAAABAAAAIAQAAACAAAAQAgAAAEAIAAANCbLkEHM5h+IDNqAAAAAElFTkSuQmCC'
)
if (-not (Test-Path -LiteralPath $ThumbsDir)) {
    New-Item -ItemType Directory -Path $ThumbsDir -Force | Out-Null
}
$before = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
Get-ChildItem -LiteralPath $ThumbsDir -Recurse -File -ErrorAction SilentlyContinue |
    ForEach-Object { [void]$before.Add($_.FullName) }

foreach ($name in $names) {
    [System.IO.File]::WriteAllBytes((Join-Path $work $name), $png)
}
$count = $names.Count
Write-Host "[smoke] exe=$Exe dir=$work thumbs=$ThumbsDir 已有缓存=$($before.Count)"

$t0 = Get-Date
$proc = Start-Process -FilePath $Exe -ArgumentList "`"$work`"" -PassThru
$respondedAt = $null
$newThumbs = 0
$deadline = $t0.AddSeconds($TimeoutSec)

try {
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        $proc.Refresh()
        if ($proc.HasExited) {
            Fail 'exited-early' ("进程在 {0:N1}s 退出（exit={1}）—— 启动即崩溃，看 stderr/事件日志" -f ((Get-Date) - $t0).TotalSeconds, $proc.ExitCode)
        }
        if (-not $respondedAt -and $proc.MainWindowHandle -ne 0 -and $proc.Responding) {
            $respondedAt = Get-Date
            Write-Host ("[smoke] 窗口响应正常：{0:N1}s" -f ($respondedAt - $t0).TotalSeconds)
        }
        $now = @(Get-ChildItem -LiteralPath $ThumbsDir -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { -not $before.Contains($_.FullName) })
        $newThumbs = $now.Count
        # 必须「同一时刻」既响应又有产出：窗口先响应、随后被同步命令占死的情况不能算过。
        if ($respondedAt -and $proc.Responding -and $newThumbs -ge $MinThumbs) {
            Write-Host ("[smoke] 缩略图新增：{0} 个（{1:N1}s）" -f $newThumbs, ((Get-Date) - $t0).TotalSeconds)
            Write-Host ("SMOKE PASS 窗口响应={0:N1}s 缩略图新增={1} 用例={2}" -f ($respondedAt - $t0).TotalSeconds, $newThumbs, $count)
            exit 0
        }
    }

    # 超时：以「超时时刻」的窗口状态分类，避免把「先响应后卡死」误报成「流水线无产出」。
    $cpu = try { [math]::Round($proc.TotalProcessorTime.TotalSeconds, 2) } catch { -1 }
    $children = (Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.Id)" -ErrorAction SilentlyContinue |
        ForEach-Object { $_.Name }) -join ','
    $alive = ($proc.MainWindowHandle -ne 0) -and $proc.Responding
    if (-not $alive) {
        $first = if ($respondedAt) { "曾在 {0:N1}s 短暂响应后卡死" -f ($respondedAt - $t0).TotalSeconds } else { "始终未响应" }
        Fail 'window-unresponsive' ("{0}s 超时：主窗口{1}（本轮响应={2}, handle={3}, CPU={4}s≈墙钟说明单线程自旋, 子进程={5}）" -f $TimeoutSec, $first, $alive, $proc.MainWindowHandle, $cpu, $children)
    }
    Fail 'pipeline-no-output' ("窗口在 {0:N1}s 已响应且超时时刻仍响应，但 {1}s 内缩略图目录无新增（新增={2}, CPU={3}s, 子进程={4}）—— 窗口活着但列举→stat→缩略图没跑起来" -f ($respondedAt - $t0).TotalSeconds, $TimeoutSec, $newThumbs, $cpu, $children)
}
finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    if (-not $KeepWorkDir) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
}
