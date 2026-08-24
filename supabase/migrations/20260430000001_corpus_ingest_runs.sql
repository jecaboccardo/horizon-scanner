-- Tracks weekly incremental corpus ingestion runs per source.
-- One row per (source, run). Watermarks let the next run pick up where this one left off.
CREATE TABLE IF NOT EXISTS public.corpus_ingest_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running', -- running | success | error
  papers_seen INTEGER NOT NULL DEFAULT 0,
  papers_added INTEGER NOT NULL DEFAULT 0,
  papers_skipped_duplicate INTEGER NOT NULL DEFAULT 0,
  -- Watermark used when starting THIS run (the floor we filtered on)
  watermark_publication_date_in DATE,
  watermark_updated_date_in TIMESTAMPTZ,
  -- Watermark to use NEXT run (max seen during THIS run)
  watermark_publication_date_out DATE,
  watermark_updated_date_out TIMESTAMPTZ,
  error_message TEXT,
  notes JSONB
);

CREATE INDEX IF NOT EXISTS idx_corpus_ingest_runs_source_completed
  ON public.corpus_ingest_runs (source, completed_at DESC)
  WHERE status = 'success';

ALTER TABLE public.corpus_ingest_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "corpus_ingest_runs_service_all" ON public.corpus_ingest_runs
  FOR ALL TO service_role USING (true);
