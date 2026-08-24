param(
  [Parameter(Mandatory = $true)][int]$Worker,
  [Parameter(Mandatory = $true)][int]$Workers,
  [string]$EnvFile = "D:\Iota\Horizon-scanner-IADB\.env",
  [string]$LogDir = "logs\sms-qwen",
  [int]$BatchSize = 8,
  [int]$MaxRequests = 1000,
  [int]$SleepMs = 250,
  [int]$AbstractCap = 800,
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

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logPath = Join-Path $LogDir "worker-$Worker.log"
$env:WORKER_ID = "sms-qwen-bg-$Worker"

while ($true) {
  "[$(Get-Date -Format o)] starting worker $Worker/$Workers" | Out-File -FilePath $logPath -Append -Encoding utf8

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    node scripts/classify-sms-qwen.mjs `
      --abstract-present `
      --workers $Workers `
      --worker $Worker `
      --batch-size $BatchSize `
      --max-requests $MaxRequests `
      --sleep-ms $SleepMs `
      --abstract-cap $AbstractCap *>> $logPath
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }

  $exitCode = $LASTEXITCODE
  "[$(Get-Date -Format o)] worker $Worker exited with code $exitCode; sleeping ${RestartSleepSeconds}s" |
    Out-File -FilePath $logPath -Append -Encoding utf8

  Start-Sleep -Seconds $RestartSleepSeconds
}
