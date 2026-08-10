# Pollybot continuous live runner.
# Keeps one visible window scanning + trading so you can lock the PC (Win+L) and leave it on.
# - Full market scan + live trade every few minutes (refreshes candidates and settles resolved positions)
# - Fast live sweep in between (re-checks cached near-term candidates and tries one bounded order)
# Stop it any time by closing this window or pressing Ctrl+C.

$ErrorActionPreference = "Continue"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$env:NO_COLOR = "1"
$env:NODE_DISABLE_COLORS = "1"

# Keep the PC awake for as long as this window is open, regardless of power-plan
# changes or OEM software re-enabling sleep. (Idle sleep only; closing a laptop lid
# is a hardware trigger this cannot override -- keep the lid open.)
try {
  Add-Type -Namespace Pollybot -Name Power -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
  # ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)
  [Pollybot.Power]::SetThreadExecutionState([uint32]"0x80000001") | Out-Null
  Write-Host "Sleep blocker active: this PC will stay awake while this window is open." -ForegroundColor Green
} catch {
  Write-Host "Could not install the sleep blocker; relying on power-plan settings." -ForegroundColor Yellow
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectRoot "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$lockPath = Join-Path $logDir "run-forever.lock"

function GetLogPath {
  # Resolve this on every write so a long-running process rolls over at midnight.
  return Join-Path $logDir ("forever-" + (Get-Date -Format "yyyy-MM-dd") + ".log")
}

function WriteLogLine([string]$line) {
  $line | Out-File -FilePath (GetLogPath) -Append -Encoding utf8
}

function Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Write-Host $line -ForegroundColor Cyan
  WriteLogLine $line
}

function RunLogged([string]$label, [string[]]$npmArgs) {
  $started = Get-Date
  Log "$label started"
  & npm.cmd @npmArgs 2>&1 | ForEach-Object {
    $line = ([string]$_) -replace "`0", ""
    Write-Host $line
    WriteLogLine $line
  }
  $exitCode = $LASTEXITCODE
  $elapsed = [int]((Get-Date) - $started).TotalSeconds
  if ($exitCode -eq 0) {
    Log "$label finished ok in ${elapsed}s"
  } else {
    Log "$label finished with exit code $exitCode in ${elapsed}s"
  }
}

function HasFreshRankingCache {
  try {
    $helper = Join-Path $projectRoot "scripts\has-fresh-ranking-cache.cjs"
    $result = @(& node.exe $helper $fullScanEveryMinutes 2>&1)
    if ($LASTEXITCODE -ne 0) {
      Log ("fresh scan cache check failed: " + (($result | Select-Object -First 2) -join " "))
      return $false
    }
    $lastLine = [string]($result | Select-Object -Last 1)
    return $lastLine.Trim() -eq "fresh"
  } catch {
    Log ("fresh scan cache check threw: " + $_.Exception.Message)
    return $false
  }
}

# Single-instance guard so two continuous runners don't overlap. Check the recorded
# process, not lock age: a legitimate full scan can run longer than 20 minutes.
if (Test-Path $lockPath) {
  $ownerPid = 0
  [void][int]::TryParse(([string](Get-Content -LiteralPath $lockPath -ErrorAction SilentlyContinue | Select-Object -First 1)).Trim(), [ref]$ownerPid)
  if ($ownerPid -gt 0 -and (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
    Write-Host "Another run-forever instance is active (PID $ownerPid). Exiting." -ForegroundColor Yellow
    exit 0
  }
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
"$PID" | Out-File -FilePath $lockPath -Force

$fullScanEveryMinutes = 30
if ($env:FULL_SCAN_EVERY_MINUTES -match '^\d+$') {
  $fullScanEveryMinutes = [Math]::Max(6, [int]$env:FULL_SCAN_EVERY_MINUTES)
}
$fullScanEvery = New-TimeSpan -Minutes $fullScanEveryMinutes
$pauseSeconds = 75
if ($env:LIVE_SWEEP_PAUSE_SECONDS -match '^\d+$') {
  $pauseSeconds = [Math]::Max(30, [int]$env:LIVE_SWEEP_PAUSE_SECONDS)
}
$lastFullScan = [DateTime]::MinValue

Write-Host "============================================================" -ForegroundColor Yellow
Write-Host " POLLYBOT CONTINUOUS RUNNER  --  LIVE ACCOUNT SAFETY GATES ON" -ForegroundColor Yellow
Write-Host " Stake, exposure, and loss limits are loaded from .env.local by the bot." -ForegroundColor Yellow
Write-Host " Directional model bets require their own flag plus global/category calibration proof." -ForegroundColor Yellow
Write-Host " Confirmed-fill reconciliation and a cross-process execution lock are mandatory." -ForegroundColor Yellow
Write-Host " Full scan+trade every $fullScanEveryMinutes min, fast sweep every ~$pauseSeconds s." -ForegroundColor Yellow
Write-Host " You can lock the PC (Win+L) and leave this window open."    -ForegroundColor Yellow
Write-Host " Close this window or press Ctrl+C to stop trading."          -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Yellow

Push-Location $projectRoot
try {
  if (HasFreshRankingCache) {
    $lastFullScan = Get-Date
    Log "fresh scan cache detected; starting with fast live sweeps before the next full scan"
  }

  while ($true) {
    # Keep the lock fresh so the single-instance guard stays accurate.
    "$PID" | Out-File -FilePath $lockPath -Force
    try {
      if (((Get-Date) - $lastFullScan) -ge $fullScanEvery) {
        Log "FULL scan + settle + live trade (npm run trade)"
        RunLogged "npm run trade" @("run", "trade")
        $lastFullScan = Get-Date
      } else {
        Log "fast live sweep (npm run live-sweep)"
        RunLogged "npm run live-sweep" @("run", "live-sweep")
      }
    } catch {
      Log ("iteration error: " + $_.Exception.Message)
    }
    Start-Sleep -Seconds $pauseSeconds
  }
} finally {
  Pop-Location
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
