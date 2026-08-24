@echo off
:: ProQuest ABI/INFORM abstract backfill — ALL papers (no venue/preset filter), year <= 2000.
::
:: Targets EVERY paper not in the denylist that is missing an abstract and dated 2000 or
:: earlier:  gap-only (abstract IS NULL) · NON-denylist (excludes is_noise + shadows,
:: canonical_work_id IS NULL) · has a DOI (DOI search finds the exact paper) · skips
:: papers already attempted (raw_data.proquest_attempt). Ordered by citation count desc,
:: so the most-cited pre-2000 papers are done first.
::
:: Addressable set (2026-06-23): ~67,300 papers. This is a multi-session campaign — the
:: NYU session expires after ~60-90 min; just re-run, it skips everything already attempted.
::
:: Flow:
::   1. Browser opens to globalhome.nyu.edu for NYU alumni login
::   2. You have ~2.5 min to log in and navigate to ProQuest ABI/INFORM
::   3. Works through up to --limit papers, then writes a re-embed id list
::   4. After a batch: re-embed the new abstracts (noise-safe, qwen-768):
::        node scripts/backfill-reembed-with-abstract.mjs --ids-file reports/proquest-written-ids-*.json
::      Run re-embed OFF-PEAK only (never embed+chat backfills while prod search is live).
::
:: Usage:
::   scripts\proquest-le2000.cmd                 (default: up to 1000 papers, year<=2000)
::   scripts\proquest-le2000.cmd --dry-run        (no writes; verify matches)
::   scripts\proquest-le2000.cmd --limit 200      (shorter session)
::   scripts\proquest-le2000.cmd --year-min 1990  (narrow the low bound)

node scripts/backfill-abstracts-proquest-browser.mjs ^
  --manual-login ^
  --year-min 1900 ^
  --year-max 2000 ^
  --limit 1000 ^
  %*
