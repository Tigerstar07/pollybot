$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env.local"

function Read-PlainSecret {
  param([Parameter(Mandatory = $true)][string]$Prompt)
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    if ($bstr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
  }
}

function Set-EnvLine {
  param(
    [Parameter(Mandatory = $true)][string[]]$Lines,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )

  $escapedName = [Regex]::Escape($Name)
  $line = "$Name=$Value"
  $updated = $false
  $result = foreach ($existing in $Lines) {
    if ($existing -match "^\s*#?\s*$escapedName=") {
      $updated = $true
      $line
    } else {
      $existing
    }
  }
  if (-not $updated) {
    $result = @($result) + $line
  }
  return @($result)
}

Write-Host "Pollybot live env setup"
Write-Host "This writes to $envPath"
Write-Host "Private values are not printed."
Write-Host ""
Write-Host "Important: POLYMARKET_FUNDER_ADDRESS must be the wallet/proxy address that holds your cash."
Write-Host "Do not use a Builder/Relayer address that Polymarket labels 'Do not send funds / API use only'."
Write-Host ""

$privateKey = Read-PlainSecret "POLYMARKET_PRIVATE_KEY"
if ($privateKey -notmatch "^(0x)?[0-9a-fA-F]{64}$") {
  throw "POLYMARKET_PRIVATE_KEY must be a 32-byte hex private key."
}
if (-not $privateKey.StartsWith("0x")) {
  $privateKey = "0x$privateKey"
}

$funderAddress = Read-Host -Prompt "POLYMARKET_FUNDER_ADDRESS"
if ($funderAddress -notmatch "^0x[0-9a-fA-F]{40}$") {
  throw "POLYMARKET_FUNDER_ADDRESS must be a 20-byte 0x address."
}

$expectedSignerAddress = Read-Host -Prompt "Expected signer address [optional]"
if (-not [string]::IsNullOrWhiteSpace($expectedSignerAddress)) {
  if ($expectedSignerAddress -notmatch "^0x[0-9a-fA-F]{40}$") {
    throw "Expected signer address must be a 20-byte 0x address."
  }
  $env:POLLYBOT_SETUP_PRIVATE_KEY = $privateKey
  try {
    $derivedSignerAddress = (& node --input-type=module -e "import { privateKeyToAccount } from 'viem/accounts'; const key = process.env.POLLYBOT_SETUP_PRIVATE_KEY; console.log(privateKeyToAccount(key).address);").Trim()
  } finally {
    Remove-Item Env:\POLLYBOT_SETUP_PRIVATE_KEY -ErrorAction SilentlyContinue
  }
  if ($derivedSignerAddress.ToLowerInvariant() -ne $expectedSignerAddress.ToLowerInvariant()) {
    throw "Private key derives to $derivedSignerAddress, not expected signer $expectedSignerAddress."
  }
  Write-Host "Signer check passed: private key derives to expected signer address."
}

$signatureType = Read-Host -Prompt "POLYMARKET_SIGNATURE_TYPE [default 3]"
if ([string]::IsNullOrWhiteSpace($signatureType)) {
  $signatureType = "3"
}
if ($signatureType -notmatch "^[0-3]$") {
  throw "POLYMARKET_SIGNATURE_TYPE must be 0, 1, 2, or 3."
}

$enableLive = Read-Host -Prompt "Enable real trading now? Type I_ACCEPT_REAL_MONEY_LOSS to enable, or press Enter to keep dry-run"

$lines = @()
if (Test-Path $envPath) {
  $lines = @(Get-Content -LiteralPath $envPath)
}

$lines = Set-EnvLine $lines "POLYMARKET_PRIVATE_KEY" $privateKey
$lines = Set-EnvLine $lines "POLYMARKET_FUNDER_ADDRESS" $funderAddress
$lines = Set-EnvLine $lines "POLYMARKET_SIGNATURE_TYPE" $signatureType
$lines = Set-EnvLine $lines "BANKROLL_EUR" "10"
$lines = Set-EnvLine $lines "BASE_BET_EUR" "0.10"
$lines = Set-EnvLine $lines "MAX_BET_EUR" "0.20"
$lines = Set-EnvLine $lines "MAX_PER_MARKET_EUR" "0.30"
$lines = Set-EnvLine $lines "MAX_OPEN_EXPOSURE_EUR" "1.00"
$lines = Set-EnvLine $lines "DAILY_LOSS_LIMIT_EUR" "0.50"
$lines = Set-EnvLine $lines "TOTAL_LOSS_LIMIT_EUR" "2.00"
$lines = Set-EnvLine $lines "MAX_LIVE_TRADES_PER_DAY" "1"
$lines = Set-EnvLine $lines "MAX_LIVE_STAKE_PER_DAY_EUR" "0.20"
$lines = Set-EnvLine $lines "LIVE_ORDER_COOLDOWN_MINUTES" "1440"

if ($enableLive -eq "I_ACCEPT_REAL_MONEY_LOSS") {
  $lines = Set-EnvLine $lines "DRY_RUN" "false"
  $lines = Set-EnvLine $lines "ENABLE_REAL_TRADING" "true"
  $lines = Set-EnvLine $lines "LIVE_TRADING_CONFIRM" "I_ACCEPT_REAL_MONEY_LOSS"
} else {
  $lines = Set-EnvLine $lines "DRY_RUN" "true"
  $lines = Set-EnvLine $lines "ENABLE_REAL_TRADING" "false"
  $lines = Set-EnvLine $lines "LIVE_TRADING_CONFIRM" ""
}

$lines | Set-Content -LiteralPath $envPath -Encoding UTF8
Write-Host ""
Write-Host "Saved .env.local with secrets redacted from console output."
Write-Host "Next: npm run live-check"
