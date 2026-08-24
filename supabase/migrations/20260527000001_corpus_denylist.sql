-- Migration: corpus_denylist table + null noise embeddings
-- 2026-05-27
--
-- Purpose:
--   1. corpus_denylist — permanent list of work IDs that must never be re-imported.
--      Populated from all current is_noise=true papers. import-corpus.mjs checks
--      this table before inserting so deleted/noised papers don't come back on
--      weekly ingest.
--
--   2. Null embeddings for is_noise=true papers — removes them from pgvector ANN
--      search without deleting the rows (rows kept as audit trail + denylist seed).
--      The SQL functions already filter is_noise IS NOT TRUE, but nulling the
--      embedding prevents noise papers from being scanned in the vector index.
--
-- Applied: 2026-05-27 via SSH on CT133

-- 1. Denylist table
CREATE TABLE IF NOT EXISTS public.corpus_denylist (
  work_id  text PRIMARY KEY,
  reason   text NOT NULL DEFAULT 'noise',
  added_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Populate from current noise papers
INSERT INTO public.corpus_denylist (work_id, reason)
SELECT id, 'is_noise'
FROM public.works
WHERE is_noise = true
ON CONFLICT (work_id) DO NOTHING;

-- 3. Null embeddings for noise papers
UPDATE public.works
SET embedding = NULL
WHERE is_noise = true
  AND embedding IS NOT NULL;
