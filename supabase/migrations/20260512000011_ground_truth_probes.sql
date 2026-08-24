-- Ground-truth diagnostic probes to compare HNSW vs exact seq scan vs FTS.
-- Lets us figure out whether ef1000's "only 20 candidates" is HNSW recall
-- failure or the corpus genuinely having few close neighbors. Service-role only.

-- Exact seq scan: returns total count of papers with similarity > threshold.
-- Uses SET enable_indexscan/bitmapscan = off to force seq scan over HNSW.
-- Slow (~20s) but ground truth.
CREATE OR REPLACE FUNCTION probe_exact_count_above(
  query_embedding extensions.vector(768),
  threshold       float DEFAULT 0.55
)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = extensions, public
SET enable_indexscan = off
SET enable_bitmapscan = off
AS $$
  SELECT count(*)
  FROM works
  WHERE embedding IS NOT NULL
    AND 1 - (embedding <=> query_embedding) > threshold;
$$;

-- Same but returns top-N IDs from exact scan (gold standard ranking).
CREATE OR REPLACE FUNCTION probe_exact_top_n(
  query_embedding extensions.vector(768),
  threshold       float DEFAULT 0.55,
  n               int   DEFAULT 100
)
RETURNS TABLE (id text, title text, similarity float)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = extensions, public
SET enable_indexscan = off
SET enable_bitmapscan = off
AS $$
  SELECT id, title, 1 - (embedding <=> query_embedding) AS similarity
  FROM works
  WHERE embedding IS NOT NULL
    AND 1 - (embedding <=> query_embedding) > threshold
  ORDER BY embedding <=> query_embedding
  LIMIT n;
$$;

-- FTS-only path: how many papers match the query text alone, no vector.
CREATE OR REPLACE FUNCTION probe_fts_count(query_text text)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = extensions, public
AS $$
  SELECT count(*)
  FROM works
  WHERE fts_vector @@ websearch_to_tsquery('english', query_text);
$$;

CREATE OR REPLACE FUNCTION probe_fts_top_n(query_text text, n int DEFAULT 100)
RETURNS TABLE (id text, title text, fts_score float)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = extensions, public
AS $$
  SELECT id, title,
    ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) AS fts_score
  FROM works
  WHERE fts_vector @@ websearch_to_tsquery('english', query_text)
  ORDER BY ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) DESC
  LIMIT n;
$$;

REVOKE EXECUTE ON FUNCTION probe_exact_count_above(extensions.vector(768), float) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION probe_exact_count_above(extensions.vector(768), float) TO service_role;
REVOKE EXECUTE ON FUNCTION probe_exact_top_n(extensions.vector(768), float, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION probe_exact_top_n(extensions.vector(768), float, int) TO service_role;
REVOKE EXECUTE ON FUNCTION probe_fts_count(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION probe_fts_count(text) TO service_role;
REVOKE EXECUTE ON FUNCTION probe_fts_top_n(text, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION probe_fts_top_n(text, int) TO service_role;

NOTIFY pgrst, 'reload schema';
