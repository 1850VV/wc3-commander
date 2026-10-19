<#
Start, stop or inspect the commander bridge on the Windows game PC.

  powershell -ExecutionPolicy Bypass -File tools\windows\bridge.ps1 status
  powershell -ExecutionPolicy Bypass -File tools\windows\bridge.ps1 start      # on the desktop
  powershell -ExecutionPolicy Bypass -File tools\windows\bridge.ps1 stop
  powershell -ExecutionPolicy Bypass -File tools\windows\bridge.ps1 install    # once: scheduled task for remote start

The game window only shows when the bridge runs in the desktop session. A program started over
SSH lands in session 0 (no desktop), so remote start goes through the scheduled task installed by
"install", which runs this script's "start" in the logged-on user's desktop session.

Python: the wc3env-127a\.venv next to this repository (override with $env:WC3ENV_PYTHON). The
system python may load another wc3env copy without a .env and then cannot find the maps.
#>
param([ValidateSet("start", "stop", "status", "install", "uninstall")][string]$Action = "status")

# Not "Stop": Windows PowerShell 5.1 then aborts on any line a native program (git, python) writes
# to stderr. Failures that matter are thrown explicitly or use -ErrorAction Stop.
$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [Text.Encoding]::UTF8  # Chinese output stays readable over SSH too
$Repo = Split-Path (Split-Path $PSScriptRoot)
$Bridge = Join-Path $Repo "bridge"
$Log = Join-Path $Bridge "run.log"
$Task = "wc3-commander-bridge"
$Port = 8790
$Python = if ($env:WC3ENV_PYTHON) { $env:WC3ENV_PYTHON } else { Join-Path (Split-Path $Repo) "wc3env-127a\.venv\Scripts\python.exe" }

function Get-BridgeProcesses {
    Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "python.exe" -and $_.CommandLine -match "-m commander_bridge" }
}

function Show-Status {
    $commit = git -C $Repo log --oneline -1 2>&1 | ForEach-Object { "$_" }
    Write-Output "代码：$commit"
    $procs = @(Get-BridgeProcesses)
    if (-not $procs) { Write-Output "服务：没有运行"; return }
    foreach ($p in $procs) {
        $where = if ($p.SessionId -eq 0) { "会话 0（后台，没有桌面，游戏窗口出不来）" } else { "会话 $($p.SessionId)（桌面）" }
        Write-Output ("服务进程 {0}：{1}" -f $p.ProcessId, $where)
    }
    try { Write-Output ("状态：" + (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/api/health" -TimeoutSec 3).Content) }
    catch { Write-Output "状态：端口 $Port 没有响应" }
}

function Stop-Bridge {
    $procs = @(Get-BridgeProcesses)
    foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($procs) { Write-Output ("已停止服务进程：" + (($procs | ForEach-Object ProcessId) -join ", ")) } else { Write-Output "服务没有在运行" }
}

switch ($Action) {
    "status" { Show-Status }
    "stop" { Stop-Bridge }
    "start" {
        if (-not (Test-Path $Python)) { throw "找不到 $Python。把 wc3env-127a 放在 wc3-commander 旁边并建好 .venv，或设置 WC3ENV_PYTHON" }
        Stop-Bridge
        $env:PYTHONIOENCODING = "utf-8"
        $Host.UI.RawUI.WindowTitle = "wc3-commander 指挥官服务（关掉这个窗口就停止）"
        Set-Location $Bridge
        $check = & $Python -c "import wc3env; from wc3env.settings import settings; print(wc3env.__file__); print(settings().game_dir)"
        if (@($check).Count -lt 2) { throw "用 $Python 加载 wc3env 失败" }
        Write-Output ("wc3env：" + $check[0])
        Write-Output ("游戏目录：" + $check[1])
        if (-not (Test-Path (Join-Path $check[1] "Maps"))) { throw "游戏目录里没有 Maps，检查 wc3env-127a\.env 的 WC3_GAME_DIR" }
        "# $(Get-Date -Format s) start" | Out-File -FilePath $Log -Encoding utf8
        # stderr lines become plain text (no red NativeCommandError) and go to the log as UTF-8
        & $Python -u -m commander_bridge --backend wc3env 2>&1 | ForEach-Object {
            $line = "$_"
            Write-Output $line
            Add-Content -Path $Log -Value $line -Encoding utf8
        }
    }
    "install" {
        $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
        $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" start" -WorkingDirectory $Bridge
        $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
        Register-ScheduledTask -TaskName $Task -Action $action -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
        Write-Output "已注册计划任务 $Task：只在你登录时、在你的桌面会话里运行；没有定时触发，只在被调用时启动。"
        Write-Output "远程启动：schtasks /Run /TN $Task    删除：bridge.ps1 uninstall"
    }
    "uninstall" {
        Unregister-ScheduledTask -TaskName $Task -Confirm:$false -ErrorAction Stop
        Write-Output "已删除计划任务 $Task"
    }
}
