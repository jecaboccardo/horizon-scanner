-- Phase 3a: BM25 full-text corpus search
-- Phase 4:  Citation graph tables and RPCs
--
-- ⚠️ SUPERSEDED / DEAD CODE (note added 2026-06-26): the `bm25_search_works` RPC
-- below is NOT called from live code. Production hybrid retrieval uses the
-- Postgres FTS path inside `match_works_v2` (ts_rank_cd + websearch_to_tsquery),
-- NOT this Okapi-BM25 expression. Kept for history; safe to drop after review.

-- ---------------------------------------------------------------------------
-- Phase 3a: BM25 RPC (functional expression — no stored column needed)
--
-- NOTE: For production scale, add a GIN index via the Supabase dashboard:
--   CREATE INDEX CONCURRENTLY idx_works_fts
--     ON public.works USING GIN (
--       to_tsvector('english', coalesce(title,'') || ' ' || coalesce(abstract,''))
--     );
-- Run this from the SQL editor (CONCURRENTLY cannot run inside a transaction).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bm25_search_works(
  query_text TEXT,
  match_count INT DEFAULT 30
)
RETURNS TABLE (
  id TEXT,
  title TEXT,
  canonical_doi TEXT,
  year INTEGER,
  abstract TEXT,
  citation_count INTEGER,
  authors JSONB,
  publication_date TEXT,
  is_open_access BOOLEAN,
  open_access_pdf_url TEXT,
  fields_of_study JSONB,
  venue TEXT,
  journal_issn TEXT,
  url TEXT,
  source TEXT,
  sms_level INTEGER,
  methodology_design TEXT,
  causal_strength TEXT,
  abs_rating TEXT,
  repec_percentile FLOAT,
  corpus_source TEXT,
  bm25_rank FLOAT
)
LANGUAGE sql STABLE
SET search_path = public
AS $func$
  SELECT
    w.id, w.title, w.canonical_doi, w.year, w.abstract,
    w.citation_count, w.authors, w.publication_date,
    w.is_open_access, w.open_access_pdf_url, w.fields_of_study,
    w.venue, w.journal_issn, w.url, w.source,
    w.sms_level, w.methodology_design, w.causal_strength,
    w.abs_rating, w.repec_percentile, w.corpus_source,
    ts_rank_cd(
      to_tsvector('english', coalesce(w.title, '') || ' ' || coalesce(w.abstract, '')),
      plainto_tsquery('english', query_text)
    ) AS bm25_rank
  FROM public.works w
  WHERE to_tsvector('english', coalesce(w.title, '') || ' ' || coalesce(w.abstract, ''))
        @@ plainto_tsquery('english', query_text)
  ORDER BY bm25_rank DESC
  LIMIT match_count;
$func$;

-- ---------------------------------------------------------------------------
-- Phase 4: Citation graph
-- ---------------------------------------------------------------------------

-- Join table: each row is one directional citation (paper A cites paper B).
-- No FK on cited_work_id intentionally — cited papers may not be in works yet.
CREATE TABLE IF NOT EXISTS public.work_citations (
  citing_work_id TEXT NOT NULL,
  cited_work_id  TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (citing_work_id, cited_work_id),
  FOREIGN KEY (citing_work_id) REFERENCES public.works(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_work_citations_citing
  ON public.work_citations (citing_work_id);

CREATE INDEX IF NOT EXISTS idx_work_citations_cited
  ON public.work_citations (cited_work_id);

ALTER TABLE public.work_citations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "citations_public_read" ON public.work_citations
  FOR SELECT USING (true);

CREATE POLICY "citations_service_role_write" ON public.work_citations
  FOR INSERT WITH CHECK (true);

-- get_related_works: co-citation similarity.
-- Finds works that are frequently cited by the same papers as the seed set.
-- Used for multi-hop expansion: "papers that share references with my evidence set".
CREATE OR REPLACE FUNCTION public.get_related_works(
  seed_work_ids TEXT[],
  match_count INT DEFAULT 20
)
RETURNS TABLE (
  id TEXT,
  title TEXT,
  canonical_doi TEXT,
  year INTEGER,
  abstract TEXT,
  citation_count INTEGER,
  authors JSONB,
  venue TEXT,
  url TEXT,
  source TEXT,
  sms_level INTEGER,
  abs_rating TEXT,
  repec_percentile FLOAT,
  corpus_source TEXT,
  co_citation_count BIGINT
)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT
    w.id, w.title, w.canonical_doi, w.year, w.abstract,
    w.citation_count, w.authors, w.venue, w.url, w.source,
    w.sms_level, w.abs_rating, w.repec_percentile, w.corpus_source,
    COUNT(*) AS co_citation_count
  FROM public.work_citations wc
  JOIN public.works w ON w.id = wc.cited_work_id
  WHERE wc.citing_work_id = ANY(seed_work_ids)
    AND NOT (wc.cited_work_id = ANY(seed_work_ids))
  GROUP BY
    w.id, w.title, w.canonical_doi, w.year, w.abstract,
    w.citation_count, w.authors, w.venue, w.url, w.source,
    w.sms_level, w.abs_rating, w.repec_percentile, w.corpus_source
  ORDER BY co_citation_count DESC, w.citation_count DESC
  LIMIT match_count;
$$;
