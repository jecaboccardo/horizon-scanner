<#
.SYNOPSIS
  ScienceDirect (Elsevier) abstract backfill - key papers, year 2000+, ABS rating 3+.

.DESCRIPTION
  ScienceDirect fronts every page with Cloudflare + PerimeterX, which fingerprints a
  Playwright-LAUNCHED browser and blocks it. This script launches a NORMAL Chrome with
  remote debugging enabled so you can pass the human-check ONCE by hand, then runs the
  Node scraper (scripts/backfill-abstracts-sciencedirect-cdp.mjs), which attaches over
  CDP and drives that already-cleared session.

  Run from the repo root: D:\Iota\Horizon-scanner-IADB

.PARAMETER Port
  Chrome remote-debugging port. Default 9224 (matches the script's --port default).

.PARAMETER ProfileDir
  Scratch Chrome profile dir (kept across runs so cookies/PerimeterX trust persist).

.PARAMETER YearMin
  Minimum publication year. Default 2000.

.PARAMETER MinAbsRating
  Minimum ABS Academic Journal Guide rating (3 or 4). Default 3 (includes 3, 4, 4*).

.PARAMETER Limit
  Max papers to scrape this run. Default 300 (~20-30 min at the script's human-paced rate).

.PARAMETER DryRun
  Count targets only; makes no writes and does not require Chrome/CDP.

.EXAMPLE
  .\scripts\run-sciencedirect-backfill.ps1
  .\scripts\run-sciencedirect-backfill.ps1 -Limit 500 -MinAbsRating 4
  .\scripts\run-sciencedirect-backfill.ps1 -DryRun
#>
param(
  [int]$Port = 9224,
  [string]$ProfileDir = "D:/tmp/sd-cdp",
  [int]$YearMin = 2000,
  [int]$MinAbsRating = 3,
  [int]$Limit = 300,
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
  "scripts/backfill-abstracts-sciencedirect-cdp.mjs",
  "--all-venues",
  "--order-by", "priority",
  "--year-min", $YearMin,
  "--min-abs-rating", $MinAbsRating,
  "--limit", $Limit,
  "--port", $Port
)

if ($DryRun) {
  Write-Host "Dry run - counting targets only (no Chrome needed)." -ForegroundColor Cyan
  & node --env-file=.env scripts/backfill-abstracts-sciencedirect-cdp.mjs --count-only --all-venues --order-by priority --year-min $YearMin --min-abs-rating $MinAbsRating --limit $Limit
  exit $LASTEXITCODE
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
    Write-Error "Could not find chrome.exe in the usual install locations. Launch it yourself with:`n  chrome.exe --remote-debugging-port=$Port --user-data-dir=$ProfileDir https://www.sciencedirect.com"
    exit 1
  }

  Start-Process -FilePath $chromePath -ArgumentList @(
    "--remote-debugging-port=$Port",
    "--user-data-dir=$ProfileDir",
    "https://www.sciencedirect.com/science/article/pii/S0047272715001176"
  )

  Write-Host ""
  Write-Host "Chrome is opening. In that window:" -ForegroundColor Yellow
  Write-Host "  1. Solve any 'Verify you are human' / 'Just a moment' / press-and-hold challenge." -ForegroundColor Yellow
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
  Write-Host "Done. If any abstracts were filled, re-embed them next:" -ForegroundColor Green
  Write-Host "  node --env-file=.env scripts/backfill-reembed-with-abstract.mjs --ids-file reports/abstracts-sciencedirect-cdp-filled-ids-<date>.json" -ForegroundColor Green
}

exit $exitCode
