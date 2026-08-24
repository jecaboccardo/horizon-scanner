param(
  [Parameter(Mandatory = $true)][int]$Worker,
  [string]$EnvFile = "D:\Iota\Horizon-scanner-IADB\.env",
  [string]$LogDir = "logs\evidence-extraction",
  [int]$BatchSize = 3,
  [int]$MaxAttempts = 3,
  [int]$RestartSleepSeconds = 20
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

$env:WORKER_BATCH_SIZE = [string]$BatchSize
$env:WORKER_MAX_ATTEMPTS = [string]$MaxAttempts

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logPath = Join-Path $LogDir "worker-$Worker.log"

while ($true) {
  "[$(Get-Date -Format o)] starting evidence worker $Worker batch=$BatchSize" |
    Out-File -FilePath $logPath -Append -Encoding utf8

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    node scripts/extraction-worker.mjs *>> $logPath
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  $exitCode = $LASTEXITCODE
  "[$(Get-Date -Format o)] evidence worker $Worker exited with code $exitCode; sleeping ${RestartSleepSeconds}s" |
    Out-File -FilePath $logPath -Append -Encoding utf8

  Start-Sleep -Seconds $RestartSleepSeconds
}
