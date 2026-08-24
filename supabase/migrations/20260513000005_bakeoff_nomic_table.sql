-- 2026-05-13 — Nomic bakeoff table (addendum to 20260513000004).
-- Missed because 000004 was already marked applied when the nomic table was added.

CREATE TABLE IF NOT EXISTS works_bakeoff_nomic (
  id           text PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  embedding    extensions.vector(768) NOT NULL,
  embedded_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bakeoff_nomic_embedding
  ON works_bakeoff_nomic USING hnsw (embedding extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

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
