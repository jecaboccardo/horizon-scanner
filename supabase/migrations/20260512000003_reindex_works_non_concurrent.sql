-- 2026-05-12 — Non-concurrent REINDEX of works embedding (HNSW) + FTS (GIN)
-- indexes. Restores match_works RPC performance after the post-backfill
-- degradation diagnosed today (see reports/devops-handoff-match-works-2026-05-12.md).
--
-- HOW THIS IS DIFFERENT FROM YESTERDAY'S OUTAGE:
--   Yesterday: REINDEX CONCURRENTLY under live traffic → planner alternated
--   between old index + _ccnew partial → match_works went from 22s to 57s.
--   Today: non-concurrent. Takes ACCESS EXCLUSIVE lock on works table for
--   the duration. Any in-flight match_works query blocks on the lock, then
--   either completes against the fresh index or times out at the 75s app
--   ceiling. No planner confusion, no partial index residue, no _ccnew.
--
-- EXPECTED IMPACT:
--   ~3-5 min where users see 504 retrieval-timeout. After rebuild
--   match_works should drop from ~28s flat to <2s.
--
-- DIAGNOSTIC FINDINGS that justified this fix:
--   probe-match-works-perf.mjs showed flat 28-29s latency regardless of
--   match_count (10→500) or match_threshold (0.30→0.55), with no run-to-run
--   warming. That's the signature of seq-scan or an invalid index, not a
--   healthy HNSW. The CONCURRENT REINDEX cancellation yesterday likely
--   left idx_works_embedding_hnsw in a degraded/INVALID state.

-- Allow the operation to take as long as it needs (db-migrate workflow
-- has its own 15-min ceiling; non-concurrent should finish in 3-5 min).
SET statement_timeout = 0;

-- Cancel any leftover REINDEX backends from yesterday's rollback so we
-- don't compete for the lock. Idempotent — safe if nothing is running.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT pid FROM pg_stat_activity
    WHERE state = 'active' AND query ILIKE 'REINDEX%works%'
  LOOP
    PERFORM pg_cancel_backend(r.pid);
    RAISE NOTICE 'Cancelled lingering REINDEX backend pid=%', r.pid;
  END LOOP;
END $$;

-- Rebuild the HNSW vector index. This is the primary suspect for the
-- match_works regression — HNSW indexes don't get fixed by ANALYZE, only
-- by REINDEX.
REINDEX INDEX idx_works_embedding_hnsw;

-- Rebuild the FTS GIN index for completeness. Faster than HNSW (~30-60s
-- typical on 622k rows).
REINDEX INDEX idx_works_fts;

-- Refresh planner stats after the rebuild so cost estimates are accurate.
ANALYZE works;
