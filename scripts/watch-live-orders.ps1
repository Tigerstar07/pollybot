$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $projectRoot "logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

Write-Host "Watching Pollybot logs for live order events. Press Ctrl+C to stop."
Write-Host "Directory: $logDirectory"

$seen = @{}
while ($true) {
  Get-ChildItem -LiteralPath $logDirectory -Filter "*.log" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime |
    ForEach-Object {
      $path = $_.FullName
      $content = Get-Content -LiteralPath $path -ErrorAction SilentlyContinue
      foreach ($line in $content) {
        if ($line -match "Live FOK order matched|Live order failed|Polymarket accepted order|Live candidate blocked") {
          $key = "$path::$line"
          if (-not $seen.ContainsKey($key)) {
            $seen[$key] = $true
            Write-Host ("[{0}] {1}" -f (Get-Date -Format "s"), $line)
          }
        }
      }
    }
  Start-Sleep -Seconds 5
}
