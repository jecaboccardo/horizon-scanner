-- Migration: paper_upload_signals (Paper Studio uploads, dual-signal capture)
-- Staging only. NEVER promoted to public.works on the request path (golden rule).
--   kind='add_existing' → we already had the paper but retrieval missed it (eval signal).
--   kind='add_new'      → a corpus gap; queued for reviewed ingestion (never automatic).
CREATE TABLE IF NOT EXISTS public.paper_upload_signals (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id     text NOT NULL,
  plan_id       text,
  search_run_id text,
  kind          text NOT NULL CHECK (kind IN ('add_existing', 'add_new')),
  matched_work_id text,            -- set when the upload already exists in works
  upload        jsonb NOT NULL,    -- the PaperPlanUpload metadata
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS paper_upload_signals_tenant_created_idx
  ON public.paper_upload_signals (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS paper_upload_signals_kind_idx
  ON public.paper_upload_signals (kind);

COMMENT ON TABLE public.paper_upload_signals IS
  'Paper Studio uploads: dual-signal staging. add_existing=retrieval miss; '
  'add_new=corpus gap. Promotion to works is a separate reviewed step, never automatic.';
