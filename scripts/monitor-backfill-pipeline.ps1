param(
  [int]$IntervalSeconds = 180,
  [int]$QueueFloor = 1000,
  [int]$ExtractionRefill = 5000,
  [int]$Tier2Refill = 5000,
  [int]$SmsLimit = 4000,
  [int]$AbstractPdfLimit = 50000,
  [int]$AbstractPageLimit = 20000,
  [string]$LogDir = "logs"
)

$ErrorActionPreference = "Continue"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-MonitorLog {
  param([string]$Message)
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  "[$stamp] $Message" | Tee-Object -FilePath (Join-Path $LogDir "backfill-monitor.log") -Append
}

function Get-NodeProcesses {
  Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "node.exe" } |
    Select-Object ProcessId, CreationDate, CommandLine
}

function Has-NodeProcess {
  param([string]$Pattern)
  $procs = Get-NodeProcesses
  return [bool]($procs | Where-Object { $_.CommandLine -like $Pattern } | Select-Object -First 1)
}

function Start-LoggedNode {
  param(
    [string[]]$Arguments,
    [string]$Name
  )
  $ts = Get-Date -Format "yyyyMMdd-HHmmss"
  $out = Join-Path $LogDir "$Name-$ts.out.log"
  $err = Join-Path $LogDir "$Name-$ts.err.log"
  Write-MonitorLog "starting $Name -> $out"
  Start-Process `
    -FilePath "node" `
    -ArgumentList $Arguments `
    -WorkingDirectory (Get-Location) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err
}

function Invoke-LoggedNode {
  param(
    [string[]]$Arguments,
    [string]$Name
  )
  $ts = Get-Date -Format "yyyyMMdd-HHmmss"
  $out = Join-Path $LogDir "$Name-$ts.out.log"
  $err = Join-Path $LogDir "$Name-$ts.err.log"
  Write-MonitorLog "running $Name -> $out"
  $proc = Start-Process `
    -FilePath "node" `
    -ArgumentList $Arguments `
    -WorkingDirectory (Get-Location) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $out `
    -RedirectStandardError $err `
    -PassThru
  $proc.WaitForExit()
  Write-MonitorLog "$Name exited code=$($proc.ExitCode)"
}

function Get-QueueState {
  $envFileArgs = @("scripts/diag-queue-json.mjs")
  $json = & node @envFileArgs 2>> (Join-Path $LogDir "backfill-monitor-probe.err.log")
  if ($LASTEXITCODE -ne 0 -or -not $json) {
    Write-MonitorLog "queue state probe failed exit=$LASTEXITCODE"
    return $null
  }
  try {
    return $json | ConvertFrom-Json
  } catch {
    Write-MonitorLog "queue state JSON parse failed: $json"
    return $null
  }
}

function Ensure-SmsWorkers {
  if (Has-NodeProcess "*scripts/classify-sms-qwen.mjs*--abstract-present*--year-min*2000*") {
    return
  }
  Write-MonitorLog "sms workers absent; restarting 2 workers"
  Start-LoggedNode @(
    "scripts/classify-sms-qwen.mjs",
    "--abstract-present",
    "--year-min", "2000",
    "--limit", "$SmsLimit",
    "--workers", "2",
    "--worker", "0",
    "--batch-size", "3",
    "--singleton-retry",
    "--max-requests", "1200",
    "--sleep-ms", "1000"
  ) "sms-qwen-2000-watch-worker-0"
  Start-LoggedNode @(
    "scripts/classify-sms-qwen.mjs",
    "--abstract-present",
    "--year-min", "2000",
    "--limit", "$SmsLimit",
    "--workers", "2",
    "--worker", "1",
    "--batch-size", "3",
    "--singleton-retry",
    "--max-requests", "1200",
    "--sleep-ms", "1000"
  ) "sms-qwen-2000-watch-worker-1"
}

function Ensure-AbstractWorkers {
  if (-not (Has-NodeProcess "*scripts/backfill-abstracts-pdf.mjs*--year-min*2000*")) {
    Start-LoggedNode @(
      "scripts/backfill-abstracts-pdf.mjs",
      "--limit", "$AbstractPdfLimit",
      "--scan-limit", "120000",
      "--year-min", "2000",
      "--all-venues",
      "--priority-mode",
      "--concurrency", "4",
      "--pages", "4"
    ) "abstract-pdf-2000-watch"
  }
  if (-not (Has-NodeProcess "*scripts/backfill-abstracts-page-metadata.mjs*--year-min*2000*")) {
    Start-LoggedNode @(
      "scripts/backfill-abstracts-page-metadata.mjs",
      "--limit", "$AbstractPageLimit",
      "--scan-limit", "120000",
      "--year-min", "2000",
      "--all-venues",
      "--priority-mode",
      "--concurrency", "6"
    ) "abstract-page-2000-watch"
  }
}

function Ensure-Queues {
  $state = Get-QueueState
  if ($null -eq $state) {
    return
  }

  Write-MonitorLog "queues extraction queued=$($state.extraction.queued) processing=$($state.extraction.processing) failed=$($state.extraction.failed); tier2 queued=$($state.tier2.queued) processing=$($state.tier2.processing) failed=$($state.tier2.failed)"

  if ([int]$state.extraction.queued -lt $QueueFloor) {
    Invoke-LoggedNode @("scripts/requeue-old-model-extraction-failures.mjs", "--limit", "$ExtractionRefill") "requeue-old-model-watch"
    Invoke-LoggedNode @(
      "scripts/enqueue.mjs",
      "--limit", "$ExtractionRefill",
      "--profile", "econ",
      "--min-econ-score", "3",
      "--scan-limit", "120000"
    ) "enqueue-econ-watch"
  }

  if ([int]$state.tier2.queued -lt $QueueFloor) {
    Invoke-LoggedNode @(
      "scripts/enqueue-tier2-card-upgrades.mjs",
      "--limit", "$Tier2Refill",
      "--scan-limit", "50000",
      "--include-no-pdf",
      "--include-blocked-pdf-hosts",
      "--include-not-ranking-usable"
    ) "tier2-enqueue-watch"
  }
}

Write-MonitorLog "backfill monitor started interval=${IntervalSeconds}s queue_floor=$QueueFloor"

while ($true) {
  try {
    Ensure-Queues
    Ensure-SmsWorkers
    Ensure-AbstractWorkers
  } catch {
    Write-MonitorLog "monitor iteration error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $IntervalSeconds
}
