-- Phase A1: Add parallel 1024-dim embedding column for qwen3-embedding:8b backfill.
--
-- This is purely additive — the existing `embedding vector(768)` column,
-- HNSW index, and `match_works` RPC are untouched. Old retrieval path
-- continues to work unchanged while we backfill the new column in the
-- background.
--
-- Cutover happens in a later migration once `embedding_1024` has full
-- coverage of the corpus.

-- 1. New column for qwen3-embedding:8b vectors (1024 dims)
ALTER TABLE public.works
  ADD COLUMN IF NOT EXISTS embedding_1024 extensions.vector(1024);

-- 2. HNSW index. Postgres maintains it incrementally as the backfill
--    populates rows, so building it now (against an empty column) is safe.
CREATE INDEX IF NOT EXISTS idx_works_embedding_1024
  ON public.works
  USING hnsw (embedding_1024 extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 3. Hybrid (vector + FTS via RRF) RPC for the 1024-dim column.
--    Mirrors the existing `match_works` signature but reads from
--    `embedding_1024` instead of `embedding`. The frontend / vectorSearch
--    layer will switch to this RPC during A3 cutover.
CREATE OR REPLACE FUNCTION match_works_1024(
  query_embedding extensions.vector(1024),
  query_text      text,
  match_threshold float DEFAULT 0.55,
  match_count     int   DEFAULT 50
)
RETURNS TABLE (
  id text, title text, abstract text, year int, citation_count int,
  canonical_doi text, authors text[], publication_date text,
  is_open_access bool, open_access_pdf_url text, fields_of_study text[],
  venue text, journal_issn text, url text, source text,
  sms_level int, methodology_design text, causal_strength text,
  abs_rating text, repec_percentile float, corpus_source text,
  scl_topics text[], similarity float, fts_rank float
)
LANGUAGE sql STABLE
SET search_path = extensions, public
AS $$
  WITH vector_hits AS (
    SELECT id, 1 - (embedding_1024 <=> query_embedding) AS similarity,
      ROW_NUMBER() OVER (ORDER BY embedding_1024 <=> query_embedding) AS vector_rank
    FROM works
    WHERE embedding_1024 IS NOT NULL
      AND 1 - (embedding_1024 <=> query_embedding) > match_threshold
    ORDER BY embedding_1024 <=> query_embedding
    LIMIT match_count * 2
  ),
  fts_hits AS (
    SELECT id,
      ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) AS fts_score,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) DESC
      ) AS fts_rank_pos
    FROM works
    WHERE fts_vector @@ websearch_to_tsquery('english', query_text)
    LIMIT match_count * 2
  ),
  rrf AS (
    SELECT
      COALESCE(v.id, f.id) AS id,
      COALESCE(v.similarity, 0) AS similarity,
      COALESCE(f.fts_score, 0) AS fts_rank,
      COALESCE(1.0 / (60 + v.vector_rank), 0) +
      COALESCE(1.0 / (60 + f.fts_rank_pos), 0) AS rrf_score
    FROM vector_hits v
    FULL OUTER JOIN fts_hits f ON v.id = f.id
  )
  SELECT
    w.id, w.title, w.abstract, w.year, w.citation_count, w.canonical_doi,
    CASE WHEN jsonb_typeof(w.authors) = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(w.authors))
         ELSE ARRAY[]::text[] END AS authors,
    w.publication_date::text, w.is_open_access, w.open_access_pdf_url,
    CASE WHEN jsonb_typeof(w.fields_of_study) = 'array'
         THEN ARRAY(SELECT jsonb_array_elements_text(w.fields_of_study))
         ELSE ARRAY[]::text[] END AS fields_of_study,
    w.venue, w.journal_issn, w.url, w.source,
    w.sms_level::int, w.methodology_design, w.causal_strength,
    w.abs_rating, w.repec_percentile::float, w.corpus_source,
    COALESCE(w.scl_topics, '{}') AS scl_topics,
    r.similarity, r.fts_rank
  FROM rrf r
  JOIN works w ON w.id = r.id
  WHERE w.excluded IS NOT TRUE
  ORDER BY r.rrf_score DESC
  LIMIT match_count;
$$;

-- 4. Convenience view: backfill progress monitor.
--    Devs / DevOps can `SELECT * FROM embedding_1024_progress` to track.
CREATE OR REPLACE VIEW public.embedding_1024_progress AS
SELECT
  COUNT(*)                                            AS total_works,
  COUNT(*) FILTER (WHERE embedding IS NOT NULL)       AS embedded_768,
  COUNT(*) FILTER (WHERE embedding_1024 IS NOT NULL)  AS embedded_1024,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE embedding_1024 IS NOT NULL) / NULLIF(COUNT(*), 0),
    2
  ) AS pct_1024
FROM public.works;
