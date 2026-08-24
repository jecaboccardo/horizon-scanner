-- Diagnostic-only RPCs: identical to match_works but with different
-- hnsw.ef_search values. Lets us A/B test the recall vs latency
-- tradeoff without touching the live match_works function. Service-role
-- only; safe to leave deployed.

CREATE OR REPLACE FUNCTION match_works_ef1000(
  query_embedding extensions.vector(768),
  query_text      text,
  match_threshold float DEFAULT 0.55,
  match_count     int   DEFAULT 50
)
RETURNS TABLE (id text, title text, similarity float, fts_rank float)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = extensions, public
SET enable_seqscan = off
SET hnsw.ef_search = 1000
AS $$
  WITH
    vector_candidates AS (
      SELECT id, 1 - (embedding <=> query_embedding) AS similarity,
             embedding <=> query_embedding AS dist
      FROM works
      WHERE embedding IS NOT NULL
        AND 1 - (embedding <=> query_embedding) > match_threshold
      ORDER BY embedding <=> query_embedding
      LIMIT match_count * 2
    ),
    vector_hits AS (
      SELECT id, similarity, ROW_NUMBER() OVER (ORDER BY dist) AS vector_rank
      FROM vector_candidates
    ),
    fts_candidates AS (
      SELECT id, ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) AS fts_score
      FROM works
      WHERE query_text IS NOT NULL AND length(trim(query_text)) > 0
        AND fts_vector @@ websearch_to_tsquery('english', query_text)
      ORDER BY ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) DESC
      LIMIT match_count * 2
    ),
    fts_hits AS (
      SELECT id, fts_score, ROW_NUMBER() OVER (ORDER BY fts_score DESC) AS fts_rank_pos
      FROM fts_candidates
    ),
    rrf AS (
      SELECT COALESCE(v.id, f.id) AS id,
             COALESCE(v.similarity, 0) AS similarity,
             COALESCE(f.fts_score, 0) AS fts_rank,
             COALESCE(1.0 / (60 + v.vector_rank), 0) +
             COALESCE(1.0 / (60 + f.fts_rank_pos), 0) AS rrf_score
      FROM vector_hits v FULL OUTER JOIN fts_hits f ON v.id = f.id
    )
  SELECT w.id, w.title, r.similarity, r.fts_rank
  FROM rrf r JOIN works w ON w.id = r.id
  WHERE w.excluded IS NOT TRUE
  ORDER BY r.rrf_score DESC
  LIMIT match_count;
$$;

CREATE OR REPLACE FUNCTION match_works_ef2000(
  query_embedding extensions.vector(768),
  query_text      text,
  match_threshold float DEFAULT 0.55,
  match_count     int   DEFAULT 50
)
RETURNS TABLE (id text, title text, similarity float, fts_rank float)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = extensions, public
SET enable_seqscan = off
SET hnsw.ef_search = 2000
AS $$
  WITH
    vector_candidates AS (
      SELECT id, 1 - (embedding <=> query_embedding) AS similarity,
             embedding <=> query_embedding AS dist
      FROM works
      WHERE embedding IS NOT NULL
        AND 1 - (embedding <=> query_embedding) > match_threshold
      ORDER BY embedding <=> query_embedding
      LIMIT match_count * 2
    ),
    vector_hits AS (
      SELECT id, similarity, ROW_NUMBER() OVER (ORDER BY dist) AS vector_rank
      FROM vector_candidates
    ),
    fts_candidates AS (
      SELECT id, ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) AS fts_score
      FROM works
      WHERE query_text IS NOT NULL AND length(trim(query_text)) > 0
        AND fts_vector @@ websearch_to_tsquery('english', query_text)
      ORDER BY ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) DESC
      LIMIT match_count * 2
    ),
    fts_hits AS (
      SELECT id, fts_score, ROW_NUMBER() OVER (ORDER BY fts_score DESC) AS fts_rank_pos
      FROM fts_candidates
    ),
    rrf AS (
      SELECT COALESCE(v.id, f.id) AS id,
             COALESCE(v.similarity, 0) AS similarity,
             COALESCE(f.fts_score, 0) AS fts_rank,
             COALESCE(1.0 / (60 + v.vector_rank), 0) +
             COALESCE(1.0 / (60 + f.fts_rank_pos), 0) AS rrf_score
      FROM vector_hits v FULL OUTER JOIN fts_hits f ON v.id = f.id
    )
  SELECT w.id, w.title, r.similarity, r.fts_rank
  FROM rrf r JOIN works w ON w.id = r.id
  WHERE w.excluded IS NOT TRUE
  ORDER BY r.rrf_score DESC
  LIMIT match_count;
$$;

REVOKE EXECUTE ON FUNCTION match_works_ef1000(extensions.vector(768), text, float, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION match_works_ef1000(extensions.vector(768), text, float, int) TO service_role;
REVOKE EXECUTE ON FUNCTION match_works_ef2000(extensions.vector(768), text, float, int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION match_works_ef2000(extensions.vector(768), text, float, int) TO service_role;

NOTIFY pgrst, 'reload schema';
