-- Phase 12: Deep Corpus RAG — pgvector embeddings
-- Adds vector search capability to the works table for semantic retrieval.

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- 2. Add embedding and corpus metadata columns to works
ALTER TABLE public.works
  ADD COLUMN IF NOT EXISTS embedding extensions.vector(768),
  ADD COLUMN IF NOT EXISTS corpus_source TEXT,          -- 'openalex_bulk', 'semantic_scholar_bulk', 'api_retrieval', null
  ADD COLUMN IF NOT EXISTS corpus_imported_at TIMESTAMPTZ;

-- 3. HNSW index for fast approximate nearest-neighbor search
-- Tuned for 10K-50K corpus: m=16, ef_construction=64
CREATE INDEX IF NOT EXISTS idx_works_embedding
  ON public.works
  USING hnsw (embedding extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- 4. Index on corpus_source for admin stats queries
CREATE INDEX IF NOT EXISTS idx_works_corpus_source
  ON public.works (corpus_source)
  WHERE corpus_source IS NOT NULL;

-- 5. Partial index on corpus_imported_at for weekly refresh queries
CREATE INDEX IF NOT EXISTS idx_works_corpus_imported_at
  ON public.works (corpus_imported_at DESC)
  WHERE corpus_imported_at IS NOT NULL;

-- 6. RPC function for vector similarity search (called by vectorSearch.ts)
CREATE OR REPLACE FUNCTION public.match_works(
  query_embedding extensions.vector(768),
  match_threshold FLOAT DEFAULT 0.60,
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
  similarity FLOAT
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
  SELECT
    w.id, w.title, w.canonical_doi, w.year, w.abstract,
    w.citation_count, w.authors, w.publication_date,
    w.is_open_access, w.open_access_pdf_url, w.fields_of_study,
    w.venue, w.journal_issn, w.url, w.source,
    w.sms_level, w.methodology_design, w.causal_strength,
    w.abs_rating, w.repec_percentile, w.corpus_source,
    1 - (w.embedding <=> query_embedding) AS similarity
  FROM public.works w
  WHERE w.embedding IS NOT NULL
    AND 1 - (w.embedding <=> query_embedding) >= match_threshold
  ORDER BY w.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- 7. RPC function for corpus stats by source (called by admin/corpus/stats)
CREATE OR REPLACE FUNCTION public.corpus_source_counts()
RETURNS TABLE (corpus_source TEXT, count BIGINT)
LANGUAGE sql STABLE
AS $$
  SELECT w.corpus_source, COUNT(*)
  FROM public.works w
  WHERE w.corpus_source IS NOT NULL
  GROUP BY w.corpus_source
  ORDER BY COUNT(*) DESC;
$$;
