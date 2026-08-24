-- Diagnostic RPC: raw HNSW scan, no FTS, no JOIN, no CTE.
-- Tells us the bare floor cost of the vector index. If this is also slow,
-- the HNSW index itself is degraded. If this is fast, the cost is in
-- some other part of match_works.

CREATE OR REPLACE FUNCTION probe_vector_only(
  query_embedding extensions.vector(768),
  match_count     int DEFAULT 50
)
RETURNS TABLE (id text, dist float)
LANGUAGE sql STABLE
SET search_path = extensions, public
AS $$
  SELECT id, embedding <=> query_embedding AS dist
  FROM works
  WHERE embedding IS NOT NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
