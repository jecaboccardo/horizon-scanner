<#
.SYNOPSIS
  Phased runner for the remaining null-abstract corpus gap. Reports the gap by slice,
  then works the API-reachable slices in value order.

.DESCRIPTION
  There are ~30 backfill-abstracts-*.mjs scripts; the hard part is knowing WHICH to
  run, in what order, and which slices the API cascade simply cannot resolve. This
  wraps that decision.

  Phases (all gap-only and resumable - safe to interrupt and re-run):
    1  2010+, ABS2+ rated, non-Elsevier   highest-value published work
    2  2010+, unrated                     working papers / IDB pubs / unrated journals
    3  pre-2010 (multisource cascade)      the BULK of the gap (~80%)

  NOT covered here, by design:
    - Elsevier/ScienceDirect (DOI 10.1016, 10.1006): the OpenAlex/Crossref/S2/EuropePMC
      cascade rarely indexes these abstracts, so phases 1-2 pass --skip-elsevier rather
      than burn calls. Use run-sciencedirect-backfill.ps1 (CDP scraper) for that slice.
    - Wiley: run-wiley-backfill.ps1. Both need a human to clear a bot-check once.

  Every fill is RETRIEVED text stamped with provenance (raw_data.abstract_source +
  abstract_backfill). Nothing is ever LLM-generated - see CLAUDE.md corpus golden rules
  and the 2026-07-15 fabricated-abstract incident.

  Expect modest hit rates: measured ~15% on the 2010+ unrated slice. The cascade only
  fills what a source actually has; an unmatched paper is left untouched for a
  publisher-specific scraper.

  Run from the repo root.

.PARAMETER Phase
  Which phase(s) to run: 1, 2, 3, or All (default). Phases run in order.

.PARAMETER Limit
  Max papers per phase. 0 = no cap (full sweep). Default 500 - a bounded first pass.

.PARAMETER DryRun
  Pass --dry-run through to the underlying scripts. Nothing is written.

.PARAMETER CountOnly
  Print the gap breakdown and exit without running any phase.

.EXAMPLE
  ./scripts/run-abstract-backfill.ps1 -CountOnly
.EXAMPLE
  ./scripts/run-abstract-backfill.ps1 -Phase 2 -Limit 200 -DryRun
.EXAMPLE
  ./scripts/run-abstract-backfill.ps1 -Limit 0        # full sweep, all phases
#>
[CmdletBinding()]
param(
  [ValidateSet('1', '2', '3', 'All')] [string] $Phase = 'All',
  [int] $Limit = 500,
  [switch] $DryRun,
  [switch] $CountOnly
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path '.env')) { throw "No .env in $(Get-Location). Run from the repo root." }
if (-not (Test-Path 'scripts/backfill-abstracts-multisource.mjs')) { throw "Run from the repo root." }

function Show-Gap {
  Write-Host "`n=== Null-abstract gap (canonical, non-noise) ===" -ForegroundColor Cyan
  # Counts come straight from PostgREST so this never drifts from the live corpus.
  node --env-file=.env -e @'
const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'count=exact', Range: '0-0' };
const n = async (qs) => {
  const r = await fetch(url.replace(/\/$/, '') + '/rest/v1/' + qs, { headers: H });
  const cr = r.headers.get('content-range') || '*/0';
  return Number(cr.split('/')[1] || 0);
};
const B = 'works?select=id&is_noise=eq.false&abstract=is.null&canonical_work_id=is.null';
const pad = (s, w) => String(s).padEnd(w);
(async () => {
  const rows = [
    ['TOTAL null-abstract',            B],
    ['  2010+ ABS2+ (phase 1)',        B + '&year=gte.2010&abs_rating=in.(2,3,4,4*)&canonical_doi=not.like.10.1016*'],
    ['  2010+ unrated (phase 2)',      B + '&year=gte.2010&abs_rating=is.null&canonical_doi=not.like.10.1016*'],
    ['  pre-2010 (phase 3)',           B + '&year=lt.2010'],
    ['  Elsevier -> CDP scraper',      B + '&canonical_doi=like.10.1016*'],
    ['  no DOI (title-match only)',    B + '&canonical_doi=is.null'],
  ];
  for (const [label, qs] of rows) console.log('  ' + pad(label, 34) + String(await n(qs)).padStart(7));
})();
'@
  if ($LASTEXITCODE -ne 0) { throw "gap count failed (exit $LASTEXITCODE)" }
}

Show-Gap
if ($CountOnly) { return }

# --limit 0 means "no cap" to this launcher; the .mjs scripts treat absent/0 as Infinity.
$limitArgs = if ($Limit -gt 0) { @('--limit', "$Limit") } else { @() }
$dryArgs = if ($DryRun) { @('--dry-run') } else { @() }

$phases = @(
  @{ Id = '1'; Name = '2010+ ABS2+ (non-Elsevier)'
     Script = 'scripts/backfill-abstracts-2010plus-abs2.mjs'
     Args = @('--min-abs-rating', '2', '--skip-elsevier') }
  @{ Id = '2'; Name = '2010+ unrated (non-Elsevier)'
     Script = 'scripts/backfill-abstracts-2010plus-abs2.mjs'
     Args = @('--unrated-only', '--skip-elsevier') }
  @{ Id = '3'; Name = 'pre-2010 multisource cascade'
     Script = 'scripts/backfill-abstracts-multisource.mjs'
     Args = @('--order-by', 'citation_count') }
)

foreach ($p in $phases) {
  if ($Phase -ne 'All' -and $Phase -ne $p.Id) { continue }
  Write-Host "`n=== Phase $($p.Id): $($p.Name) ===" -ForegroundColor Green
  $argv = @('--env-file=.env', $p.Script) + $p.Args + $limitArgs + $dryArgs
  Write-Host "node $($argv -join ' ')" -ForegroundColor DarkGray
  & node @argv
  # A non-zero exit is worth stopping on: these are long sweeps and a silent failure
  # part-way through would look like a completed phase with a poor hit rate.
  if ($LASTEXITCODE -ne 0) { throw "Phase $($p.Id) exited $LASTEXITCODE" }
}

Write-Host "`n=== Post-run gap ===" -ForegroundColor Cyan
Show-Gap
Write-Host @"

Next steps:
  * Newly filled abstracts need embeddings + an SMS grade before they affect retrieval:
      node --env-file=.env scripts/backfill-reembed-with-abstract.mjs
      node --env-file=.env scripts/classify-sms-qwen.mjs --abstract-present
  * Elsevier and Wiley slices need their CDP launchers (see .DESCRIPTION).
  * Re-run the retrieval eval afterwards - corpus changes move ranking:
      node --env-file=.env scripts/eval-gold.mjs --no-write
"@ -ForegroundColor Yellow
