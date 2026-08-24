-- Refresh planner statistics on works after a day of heavy backfills:
--   publication_type (+155k populated)
--   geography (+516k populated)
--   abs_rating (+192k populated)
--   repec_percentile (+228k populated)
--   sms_level / methodology_design / causal_strength (+101k populated, still climbing)
--   +7k new corpus_source='api_retrieval' rows with embeddings
--
-- match_works RPC measured at 22s on 2026-05-11 (vector + FTS hybrid over
-- 622k rows). Embedding generation was 102ms — the entire 22s is inside
-- Postgres. Most likely cause: stale stats post-backfill, so the planner
-- isn't picking the HNSW index or is mis-estimating cardinality on the
-- FTS half.
--
-- ANALYZE is safe (takes seconds, doesn't lock writes). If this alone
-- doesn't fix latency, the next step is REINDEX CONCURRENTLY on
-- idx_works_embedding and/or idx_works_fts — shipped as a separate
-- migration if needed.

ANALYZE works;
