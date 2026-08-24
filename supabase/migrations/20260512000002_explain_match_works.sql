-- Diagnostic-only function: returns EXPLAIN (ANALYZE, BUFFERS) output for the
-- match_works hybrid query. Lets us see plan + actual timings without VPS SSH.
-- Restricted to service_role; not callable by anon/authenticated.

CREATE OR REPLACE FUNCTION explain_match_works(
  query_embedding extensions.vector(768),
  query_text      text,
  match_threshold float DEFAULT 0.55,
  match_count     int   DEFAULT 50
)
RETURNS SETOF text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = extensions, public
AS $$
BEGIN
  RETURN QUERY EXECUTE
    'EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT) ' ||
    'WITH vector_hits AS (' ||
    '  SELECT id, 1 - (embedding <=> $1) AS similarity, ' ||
    '    ROW_NUMBER() OVER (ORDER BY embedding <=> $1) AS vector_rank ' ||
    '  FROM works ' ||
    '  WHERE embedding IS NOT NULL ' ||
    '    AND 1 - (embedding <=> $1) > $3 ' ||
    '  ORDER BY embedding <=> $1 ' ||
    '  LIMIT $4 * 2' ||
    '), fts_hits AS (' ||
    '  SELECT id, ts_rank_cd(fts_vector, websearch_to_tsquery(''english'', $2)) AS fts_score, ' ||
    '    ROW_NUMBER() OVER (ORDER BY ts_rank_cd(fts_vector, websearch_to_tsquery(''english'', $2)) DESC) AS fts_rank_pos ' ||
    '  FROM works ' ||
    '  WHERE fts_vector @@ websearch_to_tsquery(''english'', $2) ' ||
    '  LIMIT $4 * 2' ||
    '), rrf AS (' ||
    '  SELECT COALESCE(v.id, f.id) AS id, ' ||
    '    COALESCE(v.similarity, 0) AS similarity, ' ||
    '    COALESCE(f.fts_score, 0) AS fts_rank, ' ||
    '    COALESCE(1.0 / (60 + v.vector_rank), 0) + COALESCE(1.0 / (60 + f.fts_rank_pos), 0) AS rrf_score ' ||
    '  FROM vector_hits v FULL OUTER JOIN fts_hits f ON v.id = f.id' ||
    ') ' ||
    'SELECT w.id FROM rrf r JOIN works w ON w.id = r.id ' ||
    'WHERE w.excluded IS NOT TRUE ORDER BY r.rrf_score DESC LIMIT $4'
  USING query_embedding, query_text, match_threshold, match_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION explain_match_works(extensions.vector(768), text, float, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION explain_match_works(extensions.vector(768), text, float, int) TO service_role;
