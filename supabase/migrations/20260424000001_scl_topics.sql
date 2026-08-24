-- ============================================================
-- Pending schema changes — run all at once in Supabase SQL editor
-- on the self-hosted instance (15.235.47.35)
-- ============================================================

-- 1. SCL topic tags and source type
ALTER TABLE works ADD COLUMN IF NOT EXISTS scl_topics text[] DEFAULT '{}';
ALTER TABLE works ADD COLUMN IF NOT EXISTS source_type text DEFAULT 'academic';

CREATE INDEX IF NOT EXISTS idx_works_scl_topics ON works USING GIN(scl_topics);
CREATE INDEX IF NOT EXISTS idx_works_source_type ON works (source_type);

-- 2. Full-text search vector (BM25 hybrid search)
ALTER TABLE works ADD COLUMN IF NOT EXISTS fts_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(title, '') || ' ' || coalesce(abstract, '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_works_fts ON works USING GIN(fts_vector);

-- 3. Update match_works RPC to return fts_rank alongside similarity
--    (allows hybrid RRF scoring in vectorSearch.ts)
CREATE OR REPLACE FUNCTION match_works(
  query_embedding vector(768),
  query_text      text,
  match_threshold float DEFAULT 0.55,
  match_count     int   DEFAULT 50
)
RETURNS TABLE (
  id                  text,
  title               text,
  abstract            text,
  year                int,
  citation_count      int,
  canonical_doi       text,
  authors             text[],
  publication_date    text,
  is_open_access      bool,
  open_access_pdf_url text,
  fields_of_study     text[],
  venue               text,
  journal_issn        text,
  url                 text,
  source              text,
  sms_level           int,
  methodology_design  text,
  causal_strength     text,
  abs_rating          text,
  repec_percentile    float,
  corpus_source       text,
  scl_topics          text[],
  similarity          float,
  fts_rank            float
)
LANGUAGE sql STABLE
AS $$
  WITH vector_hits AS (
    SELECT
      id,
      1 - (embedding <=> query_embedding) AS similarity,
      ROW_NUMBER() OVER (ORDER BY embedding <=> query_embedding) AS vector_rank
    FROM works
    WHERE embedding IS NOT NULL
      AND 1 - (embedding <=> query_embedding) > match_threshold
    ORDER BY embedding <=> query_embedding
    LIMIT match_count * 2
  ),
  fts_hits AS (
    SELECT
      id,
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
      -- Reciprocal Rank Fusion: 1/(k + rank), k=60
      COALESCE(1.0 / (60 + v.vector_rank), 0) +
      COALESCE(1.0 / (60 + f.fts_rank_pos), 0) AS rrf_score
    FROM vector_hits v
    FULL OUTER JOIN fts_hits f ON v.id = f.id
  )
  SELECT
    w.id, w.title, w.abstract, w.year, w.citation_count, w.canonical_doi,
    w.authors, w.publication_date::text, w.is_open_access, w.open_access_pdf_url,
    w.fields_of_study, w.venue, w.journal_issn, w.url, w.source,
    w.sms_level, w.methodology_design, w.causal_strength,
    w.abs_rating, w.repec_percentile, w.corpus_source,
    COALESCE(w.scl_topics, '{}') AS scl_topics,
    r.similarity,
    r.fts_rank
  FROM rrf r
  JOIN works w ON w.id = r.id
  WHERE w.excluded IS NOT TRUE
  ORDER BY r.rrf_score DESC
  LIMIT match_count;
$$;
