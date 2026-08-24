param(
  [Parameter(Mandatory = $true)][int]$Worker,
  [string]$EnvFile = "D:\Iota\Horizon-scanner-IADB\.env",
  [string]$LogDir = "logs\tier2-upgrades",
  [string]$Model = "qwen2.5:14b-synthesis",
  [int]$BatchSize = 1,
  [int]$PdfPages = 16,
  [int]$MaxAttempts = 2,
  [int]$RestartSleepSeconds = 30
)

$ErrorActionPreference = "Stop"

Get-Content -LiteralPath $EnvFile |
  Where-Object { $_ -match '^\s*[^#][^=]+=' } |
  ForEach-Object {
    $idx = $_.IndexOf('=')
    $name = $_.Substring(0, $idx).Trim()
    $value = $_.Substring($idx + 1).Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }

if (-not $env:LLM_ENDPOINT -and $env:LLM_BASE_URL) {
  $env:LLM_ENDPOINT = $env:LLM_BASE_URL.TrimEnd('/') + '/v1/chat/completions'
}

$env:TIER2_BATCH_SIZE = [string]$BatchSize
$env:TIER2_MODEL = $Model
$env:TIER2_PDF_PAGES = [string]$PdfPages
$env:TIER2_MAX_ATTEMPTS = [string]$MaxAttempts

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logPath = Join-Path $LogDir "worker-$Worker.log"

while ($true) {
  "[$(Get-Date -Format o)] starting tier2 upgrade worker $Worker model=$Model batch=$BatchSize pages=$PdfPages" |
    Out-File -FilePath $logPath -Append -Encoding utf8

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    node scripts/tier2-upgrade-worker.mjs *>> $logPath
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  $exitCode = $LASTEXITCODE
  "[$(Get-Date -Format o)] tier2 upgrade worker $Worker exited with code $exitCode; sleeping ${RestartSleepSeconds}s" |
    Out-File -FilePath $logPath -Append -Encoding utf8

  Start-Sleep -Seconds $RestartSleepSeconds
}
