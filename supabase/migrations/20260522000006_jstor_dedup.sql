-- Migration: JSTOR (10.2307/) deduplication
--
-- 79,955 JSTOR DOIs in corpus. 4,984 have an unambiguous 1:1 publisher DOI
-- match (same title + year + identical authors). 74,288 have no publisher
-- match and remain canonical. 114 ambiguous (multi-match on either side) skipped.
--
-- Verification: every pair reviewed showed exact author match — JSTOR simply
-- republishes the same paper under a 10.2307/ DOI alongside the publisher DOI.
--
-- Passes: abstract → geography → citation_count MAX → mark shadows → clean queue.
-- Applied directly on 2026-05-22. This file documents what was run.

-- Steps inlined as separate statements (avoid temp table across connections).
-- See scripts in conversation history for full paramiko invocation.

-- After apply:
--   total_shadows  ≈ 8,117  (5 doubled-slash + 3,128 cross-source + 4,984 JSTOR)
--   jstor_shadows  = 4,984
--   JSTOR papers without publisher match remain canonical (74,288)
