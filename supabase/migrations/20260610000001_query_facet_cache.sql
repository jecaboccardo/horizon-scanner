-- Persistent cache for LLM query-facet decompositions (queryFacets.ts).
-- The in-memory LRU is per-process; every deno-api restart (= every deploy)
-- re-paid a nondeterministic Qwen call, moving canary ranks 10+ positions
-- between otherwise-identical runs (probe-variant-shootout 2026-06-10).
-- Keyed by (query_key, prompt_version) so prompt changes invalidate cleanly.

CREATE TABLE IF NOT EXISTS public.query_facet_cache (
  query_key      text        NOT NULL,
  prompt_version text        NOT NULL,
  facets         jsonb       NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (query_key, prompt_version)
);

COMMENT ON TABLE public.query_facet_cache IS
  'Read-through cache for Qwen query-facet decompositions. Written fire-and-forget by decomposeQuery(); safe to truncate at any time.';
