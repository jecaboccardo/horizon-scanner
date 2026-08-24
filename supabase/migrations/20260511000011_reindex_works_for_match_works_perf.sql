-- EMERGENCY ROLLBACK 2026-05-11 — production rescue.
--
-- Previous content of this file attempted REINDEX CONCURRENTLY on
-- idx_works_embedding + idx_works_fts. The rebuild on 622k rows was
-- still in progress when the workflow timed out at 15 min, and during
-- the rebuild match_works degraded from ~22s to ~57s, causing
-- production search to return 0 results (retrieval timeout).
--
-- This rewrite of the same migration filename cancels any running
-- REINDEX, drops the partial _ccnew indexes left behind, and lets the
-- original indexes serve queries normally. Idempotent — safe to run
-- even if no REINDEX is active.
--
-- REINDEX CONCURRENTLY cannot run in a transaction; same for the
-- DROP INDEX CONCURRENTLY calls below. psql treats each statement
-- here as its own transaction.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT pid
    FROM pg_stat_activity
    WHERE state = 'active'
      AND query ILIKE 'REINDEX%works%'
  LOOP
    PERFORM pg_cancel_backend(r.pid);
    RAISE NOTICE 'Cancelled REINDEX backend pid=%', r.pid;
  END LOOP;
END $$;

-- Brief settle to let cancellations process before DROP CONCURRENTLY
SELECT pg_sleep(2);

DROP INDEX CONCURRENTLY IF EXISTS idx_works_embedding_ccnew;
DROP INDEX CONCURRENTLY IF EXISTS idx_works_fts_ccnew;

ANALYZE works;
