param(
  [string]$TaskName = "PollybotLiveSweep",
  [int]$IntervalMinutes = 10
)

$ErrorActionPreference = "Stop"
$runner = Join-Path $PSScriptRoot "run-live-sweep.ps1"

if (-not (Test-Path $runner)) {
  throw "Runner script not found: $runner"
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 365)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Runs Pollybot live candidate sweep every $IntervalMinutes minutes with local lock protection." `
  -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' every $IntervalMinutes minutes."
