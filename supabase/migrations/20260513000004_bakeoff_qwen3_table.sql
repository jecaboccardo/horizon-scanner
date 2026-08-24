-- 2026-05-13 — Temporary bakeoff table for qwen3-embedding:8b (4096 dims).
--
-- Used to compare qwen3 vs nomic-embed-text (768 dims) on 20k papers.
-- Safe to drop after bakeoff. Does NOT affect production retrieval.
-- Schema migration only if qwen3 wins the eval.

CREATE TABLE IF NOT EXISTS works_bakeoff_qwen3 (
  id           text PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  embedding    extensions.vector(4096) NOT NULL,
  embedded_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bakeoff_qwen3_embedding
  ON works_bakeoff_qwen3 USING hnsw (embedding extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Direct cosine search over the bakeoff table.
CREATE OR REPLACE FUNCTION search_bakeoff_qwen3(
  query_embedding extensions.vector(4096),
  match_threshold float DEFAULT 0.30,
  match_count     int   DEFAULT 50,
  restrict_ids    text[] DEFAULT NULL  -- optional: limit to these paper IDs
)
RETURNS TABLE (
  id text, title text, abstract text, year int, canonical_doi text,
  venue text, sms_level int, similarity float
)
LANGUAGE sql STABLE
SET search_path = extensions, public
AS $$
  SELECT
    w.id, w.title, w.abstract, w.year, w.canonical_doi, w.venue,
    w.sms_level::int,
    1 - (b.embedding <=> query_embedding) AS similarity
  FROM works_bakeoff_qwen3 b
  JOIN works w ON w.id = b.id
  WHERE 1 - (b.embedding <=> query_embedding) > match_threshold
    AND (restrict_ids IS NULL OR b.id = ANY(restrict_ids))
  ORDER BY b.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Nomic bakeoff table — same paper slice as qwen3 but 768-dim nomic vectors.
-- Fair latency comparison: both models scan the same N rows.
CREATE TABLE IF NOT EXISTS works_bakeoff_nomic (
  id           text PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  embedding    extensions.vector(768) NOT NULL,
  embedded_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bakeoff_nomic_embedding
  ON works_bakeoff_nomic USING hnsw (embedding extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Nomic search over bakeoff table (fair: same row count as qwen3).
CREATE OR REPLACE FUNCTION search_bakeoff_nomic(
  query_embedding extensions.vector(768),
  match_threshold float DEFAULT 0.30,
  match_count     int   DEFAULT 50,
  restrict_ids    text[] DEFAULT NULL
)
RETURNS TABLE (
  id text, title text, abstract text, year int, canonical_doi text,
  venue text, sms_level int, similarity float
)
LANGUAGE sql STABLE
SET search_path = extensions, public
AS $$
  SELECT
    w.id, w.title, w.abstract, w.year, w.canonical_doi, w.venue,
    w.sms_level::int,
    1 - (b.embedding <=> query_embedding) AS similarity
  FROM works_bakeoff_nomic b
  JOIN works w ON w.id = b.id
  WHERE 1 - (b.embedding <=> query_embedding) > match_threshold
    AND (restrict_ids IS NULL OR b.id = ANY(restrict_ids))
  ORDER BY b.embedding <=> query_embedding
  LIMIT match_count;
$$;

NOTIFY pgrst, 'reload schema';
