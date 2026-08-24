param(
  [string]$LogPath = "logs/source-family-backfill.log",
  [int]$Limit = 0
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

"===== $(Get-Date -Format o) source-family backfill start =====" | Out-File -FilePath $ResolvedLogPath -Append -Encoding utf8

$argsList = @("scripts/backfill-source-family-venue-kind.mjs")
if ($Limit -gt 0) {
  $argsList += @("--limit", [string]$Limit)
}

try {
  & node @argsList 2>&1 | Tee-Object -FilePath $ResolvedLogPath -Append
} catch {
  "ERROR: $($_.Exception.Message)" | Out-File -FilePath $ResolvedLogPath -Append -Encoding utf8
  throw
}

"===== $(Get-Date -Format o) source-family backfill end =====" | Out-File -FilePath $ResolvedLogPath -Append -Encoding utf8
