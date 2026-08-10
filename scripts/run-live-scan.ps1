$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot "logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

$lockPath = Join-Path $logDirectory "live-scan.lock"
$logPath = Join-Path $logDirectory ("live-scan-" + (Get-Date -Format "yyyy-MM-dd") + ".log")

if (Test-Path $lockPath) {
  $ageMinutes = ((Get-Date) - (Get-Item -LiteralPath $lockPath).LastWriteTime).TotalMinutes
  if ($ageMinutes -lt 45) {
    ("[{0}] Skipping live scan because another run appears active." -f (Get-Date -Format "s")) | Out-File -FilePath $logPath -Append
    exit 0
  }
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}

New-Item -ItemType File -Path $lockPath -Force | Out-Null
Push-Location $projectRoot
try {
  ("[{0}] Starting Pollybot live scan/trade" -f (Get-Date -Format "s")) | Out-File -FilePath $logPath -Append
  & cmd.exe /d /c "npm.cmd run trade >> `"$logPath`" 2>&1"
  $exitCode = $LASTEXITCODE
  ("[{0}] Finished with exit code {1}" -f (Get-Date -Format "s"), $exitCode) | Out-File -FilePath $logPath -Append
  exit $exitCode
} catch {
  ("[{0}] Live scan failed: {1}" -f (Get-Date -Format "s"), $_.Exception.Message) | Out-File -FilePath $logPath -Append
  exit 1
} finally {
  Pop-Location
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
