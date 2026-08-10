$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot "logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$logPath = Join-Path $logDirectory ("daily-" + (Get-Date -Format "yyyy-MM-dd") + ".log")

Push-Location $projectRoot
try {
  ("[{0}] Starting Pollybot daily run" -f (Get-Date -Format "s")) | Out-File -FilePath $logPath -Append
  & npm.cmd run daily *>> $logPath
  $exitCode = $LASTEXITCODE
  ("[{0}] Finished with exit code {1}" -f (Get-Date -Format "s"), $exitCode) | Out-File -FilePath $logPath -Append
  exit $exitCode
} catch {
  ("[{0}] Daily run failed: {1}" -f (Get-Date -Format "s"), $_.Exception.Message) | Out-File -FilePath $logPath -Append
  exit 1
} finally {
  Pop-Location
}
