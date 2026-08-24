-- 2026-06-03: Channel-of-origin persistence.
--
-- Persists, per search run, a map of workId -> the retrieval channel(s) that
-- actually surfaced that paper (causal / recent / foundational / lac). This is
-- ADDITIVE telemetry/provenance only: it does NOT affect retrieval ranking or
-- which papers are returned. The frontend prefers these TRUE channels when
-- rendering the channel pills, falling back to the deterministic priority
-- recompute (tagChannels) for legacy rows where this column is NULL.
--
-- Shape: { "<workId>": ["causal", "lac"], "<workId2>": ["foundational"], ... }
-- Papers found only by plain vector/FTS corpus search have no entry (or []).
--
-- Idempotent: safe to re-run.

ALTER TABLE public.search_runs
  ADD COLUMN IF NOT EXISTS work_channels jsonb;

COMMENT ON COLUMN public.search_runs.work_channels IS
  'workId -> channel-of-origin ids (causal/recent/foundational/lac). Additive provenance; does not affect ranking. NULL on legacy rows.';
