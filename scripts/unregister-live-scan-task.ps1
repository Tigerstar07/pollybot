param(
  [string]$TaskName = "PollybotLiveScan"
)

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Unregistered scheduled task '$TaskName'."
} else {
  Write-Host "Scheduled task '$TaskName' was not registered."
}
