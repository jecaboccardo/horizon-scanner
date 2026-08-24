@echo off
:: ProQuest ABI/INFORM abstract backfill -- Journal of Development Economics (JDE), 2000+
::
:: Targets the JDE abstract gap (~1,010 papers 2000+ with a DOI, not yet attempted)
:: via NYU-authenticated ProQuest ABI/INFORM. Gap-only + citation-ordered (highest
:: first) + attempt-marked, so re-runs skip known failures and hit only new gaps.
:: Golden-rule safe: only writes `abstract` when it is currently NULL.
::
:: Flow:
::   1. Browser opens to globalhome.nyu.edu -- you have ~2.5 min to log in and
::      navigate to ProQuest ABI/INFORM (the session profile is reused across runs).
::   2. Script searches each paper by QUOTED TITLE, opens the top result, verifies
::      the full docview title, and writes the abstract only on a title match.
::   3. Session expires after ~60-90 min -- just re-run to continue (skips attempted).
::
:: Expected yield: ~42-60%% hit rate on applied-econ venues (JDE indexes well).
::
:: Usage:
::   scripts\proquest-jde.cmd                 (live, up to 1000 papers, 2000+)
::   scripts\proquest-jde.cmd --dry-run --limit 10   (sanity-check matching first)
::   scripts\proquest-jde.cmd --limit 300            (smaller batch)
::   scripts\proquest-jde.cmd --year-min 1960        (include pre-2000 JDE too)
::
:: After a batch, embed the new abstracts so they help retrieval:
::   node scripts/backfill-embed-new.mjs

node scripts/backfill-abstracts-proquest-browser.mjs ^
  --manual-login ^
  --venues "Journal of Development Economics" ^
  --year-min 2000 ^
  --limit 1000 ^
  %*
