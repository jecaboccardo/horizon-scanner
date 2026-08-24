@echo off
:: ProQuest ABI/INFORM abstract backfill — applied econ journals, 2000+, limit 1000
::
:: Uses the "applied-econ" preset (26 applied economics journals, excludes theory/
:: pure-econometrics venues: JET, Econometrica, J.Econometrics, Games).
::
:: Flow:
::   1. Browser opens to globalhome.nyu.edu for NYU alumni login
::   2. You have 2.5 min to log in and navigate to ProQuest ABI/INFORM
::   3. Script works through up to 1000 papers ordered by citation count (highest first)
::   4. Session expires after ~60-90 min — re-run to continue (skips already-attempted)
::
:: Expected yield: ~420-600 new abstracts per full session (42-60%% hit rate)
::
:: Usage:
::   scripts\proquest-applied-econ.cmd
::   scripts\proquest-applied-econ.cmd --dry-run
::   scripts\proquest-applied-econ.cmd --limit 200

node scripts/backfill-abstracts-proquest-browser.mjs ^
  --manual-login ^
  --preset applied-econ ^
  --abs-ratings "3,4,4*" ^
  --year-min 2000 ^
  --limit 1000 ^
  %*
