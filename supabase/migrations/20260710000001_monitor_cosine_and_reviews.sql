-- Monitoring support: (1) per-search cosine summary so the "cosine high?" health
-- check is always-on; (2) persisted on-demand JEL quality reviews so re-viewing is free.
-- Apply with scripts/apply-migrations.mjs (DDL — not via PostgREST).

ALTER TABLE public.search_runs
  ADD COLUMN IF NOT EXISTS top_cosine  real,
  ADD COLUMN IF NOT EXISTS mean_cosine real;

COMMENT ON COLUMN public.search_runs.top_cosine  IS 'Max query·paper cosine over the evidence set at search time. NULL on legacy runs.';
COMMENT ON COLUMN public.search_runs.mean_cosine IS 'Mean query·paper cosine over the evidence set at search time. NULL on legacy runs.';

CREATE TABLE IF NOT EXISTS public.jel_paper_reviews (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  paper_id    text NOT NULL,
  tenant_id   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  model       text,
  overall     text,          -- 'good' | 'mixed' | 'weak'
  findings    jsonb NOT NULL DEFAULT '[]',  -- [{dimension, section, severity, quote, note}]
  raw         jsonb
);
CREATE INDEX IF NOT EXISTS jel_paper_reviews_paper_idx ON public.jel_paper_reviews (paper_id, created_at DESC);
