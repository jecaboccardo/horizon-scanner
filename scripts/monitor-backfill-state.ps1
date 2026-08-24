param(
  [int]$IntervalSeconds = 900,
  [string]$LogPath = "logs/backfill-monitor.log"
)

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$ResolvedLogPath = if ([System.IO.Path]::IsPathRooted($LogPath)) {
  $LogPath
} else {
  Join-Path $RepoRoot $LogPath
}

$LogDir = Split-Path -Parent $ResolvedLogPath
if ($LogDir) {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
}

function Set-LocalEnv {
  if (-not (Test-Path -LiteralPath ".env")) {
    return
  }

  $lines = Get-Content -LiteralPath ".env" | Where-Object { $_ -match '^\s*[^#][^=]+=' }
  foreach ($line in $lines) {
    $parts = $line -split '=', 2
    [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), 'Process')
  }
}

while ($true) {
  "===== $(Get-Date -Format o) =====" | Out-File -FilePath $ResolvedLogPath -Append -Encoding utf8

  try {
    Set-LocalEnv
    node scripts/diag-backfill-state.mjs 2>&1 | Out-File -FilePath $ResolvedLogPath -Append -Encoding utf8
  } catch {
    "ERROR: $($_.Exception.Message)" | Out-File -FilePath $ResolvedLogPath -Append -Encoding utf8
  }

  "" | Out-File -FilePath $ResolvedLogPath -Append -Encoding utf8
  Start-Sleep -Seconds $IntervalSeconds
}
