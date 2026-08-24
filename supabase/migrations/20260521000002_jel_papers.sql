-- Migration: jel_papers
-- Long-form JEL survey articles generated asynchronously from evidence briefs.
-- Status lifecycle: queued → running → done | error
-- Sections grow incrementally as sections are drafted (sections JSONB array).

CREATE TABLE IF NOT EXISTS public.jel_papers (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text        NOT NULL,
  search_run_id   uuid        REFERENCES public.search_runs(id) ON DELETE CASCADE,
  brief_id        uuid,
  status          text        NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued', 'running', 'done', 'error')),
  query           text        NOT NULL,
  outline         jsonb,
  sections        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  word_count      integer,
  citation_count  integer,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS jel_papers_tenant_created_idx
  ON public.jel_papers (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS jel_papers_search_run_idx
  ON public.jel_papers (search_run_id);

CREATE INDEX IF NOT EXISTS jel_papers_status_idx
  ON public.jel_papers (status)
  WHERE status IN ('queued', 'running');

COMMENT ON TABLE public.jel_papers IS
  'Long-form JEL survey articles generated asynchronously from evidence briefs. '
  'Sections are written incrementally; status tracks job lifecycle.';
