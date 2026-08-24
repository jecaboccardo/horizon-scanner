<#
.SYNOPSIS
  Wiley (Online Library) abstract backfill - launches Chrome for the one-time
  human-check, then runs the CDP scraper. Sibling of run-sciencedirect-backfill.ps1.

.DESCRIPTION
  Wiley's Online Library fronts pages with Cloudflare, which blocks a
  Playwright-LAUNCHED browser. This script launches a NORMAL Chrome with remote
  debugging enabled so you can pass the human-check ONCE by hand, then runs the
  Node scraper (scripts/backfill-abstracts-wiley-cdp.mjs), which attaches over CDP
  and drives that already-cleared session.

  Uses port 9225 and profile D:/tmp/wiley-cdp - DISTINCT from the ScienceDirect
  launcher (port 9224, profile D:/tmp/sd-cdp) - so you can run BOTH at the same
  time (different publisher = different site = no bot-block interference).

  Run from the repo root: D:\Iota\Horizon-scanner-IADB

.PARAMETER Port
  Chrome remote-debugging port. Default 9225 (matches the script's --port default).

.PARAMETER ProfileDir
  Scratch Chrome profile dir (kept across runs so cookies/Cloudflare trust persist).

.PARAMETER YearMin
  Minimum publication year. Default 2000.

.PARAMETER Limit
  Max papers to scrape this run. Default 300.

.PARAMETER Venues
  Optional comma-separated venue filter (default: all Wiley targets).

.PARAMETER DryRun
  Test-extract mode: drives Chrome and reports what it WOULD fill, but makes no
  DB writes. (Wiley has no Chrome-free count mode, so this still launches Chrome.)

.EXAMPLE
  .\scripts\run-wiley-backfill.ps1
  .\scripts\run-wiley-backfill.ps1 -Limit 500
  .\scripts\run-wiley-backfill.ps1 -DryRun
#>
param(
  [int]$Port = 9225,
  [string]$ProfileDir = "D:/tmp/wiley-cdp",
  [int]$YearMin = 2000,
  [int]$Limit = 300,
  [string]$Venues = "",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Repo root is derived from this script's own location, not hardcoded — the repo has
# already moved once (D:\Iota -> D:\IADB work), which silently broke this launcher.
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
if (-not (Test-Path (Join-Path $repoRoot '.env'))) { throw "No .env at $repoRoot" }

$nodeArgs = @(
  "--env-file=.env",
  "scripts/backfill-abstracts-wiley-cdp.mjs",
  "--year-min", $YearMin,
  "--limit", $Limit,
  "--port", $Port
)
if ($Venues -ne "") { $nodeArgs += @("--venues", $Venues) }
if ($DryRun) {
  $nodeArgs += "--dry-run"
  Write-Host "Dry-run (test-extract, NO DB writes) - still needs Chrome for Wiley." -ForegroundColor Cyan
}

# 1. Find or launch Chrome with remote debugging on $Port.
$cdpUp = $false
try {
  $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2
  if ($probe.StatusCode -eq 200) { $cdpUp = $true }
} catch { $cdpUp = $false }

if (-not $cdpUp) {
  Write-Host "Launching Chrome with --remote-debugging-port=$Port ..." -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

  $chromeCandidates = @(
    "C:\Program Files\Google\Chrome\Application\chrome.exe",
    "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
  )
  $chromePath = $chromeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $chromePath) {
    Write-Error "Could not find chrome.exe in the usual install locations. Launch it yourself with:`n  chrome.exe --remote-debugging-port=$Port --user-data-dir=$ProfileDir https://onlinelibrary.wiley.com/doi/10.1111/ehr.13319"
    exit 1
  }

  Start-Process -FilePath $chromePath -ArgumentList @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$ProfileDir",
    "https://onlinelibrary.wiley.com/doi/10.1111/ehr.13319"
  )

  Write-Host ""
  Write-Host "Chrome is opening. In that window:" -ForegroundColor Yellow
  Write-Host "  1. Solve any 'Verify you are human' / 'Just a moment' challenge." -ForegroundColor Yellow
  Write-Host "  2. Wait until the article page fully renders (title + abstract visible)." -ForegroundColor Yellow
  Write-Host "  3. Leave the window open - do not close it." -ForegroundColor Yellow
  Write-Host ""
  Read-Host "Press Enter here once the article page has rendered and the challenge is cleared"
} else {
  Write-Host "Chrome CDP already listening on port $Port - reusing it." -ForegroundColor Green
}

# 2. Run the scraper (it re-checks for a challenge on every page and waits for you to clear it).
Write-Host ""
Write-Host "Running: node $($nodeArgs -join ' ')" -ForegroundColor Cyan
& node @nodeArgs
$exitCode = $LASTEXITCODE

if ($exitCode -eq 0) {
  Write-Host ""
  Write-Host "Done. If any abstracts were filled, re-embed them next (off-peak - uses the GPU):" -ForegroundColor Green
  Write-Host "  node --env-file=.env scripts/backfill-reembed-with-abstract.mjs --stale" -ForegroundColor Green
}

exit $exitCode
