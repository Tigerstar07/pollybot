param(
  [string]$TaskName = "PollybotDaily"
)

$ErrorActionPreference = "Stop"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output "Removed task '$TaskName'."
