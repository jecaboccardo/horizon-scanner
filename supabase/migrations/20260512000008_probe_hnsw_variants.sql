-- A/B test variants of the raw vector search to find which knob unlocks HNSW.
-- All return the same data; only the GUC tweaks differ. Restrict to service_role.

-- Variant A: force the planner to skip seqscan.
CREATE OR REPLACE FUNCTION probe_vec_noseqscan(query_embedding extensions.vector(768), match_count int DEFAULT 10)
RETURNS TABLE (id text, dist float)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = extensions, public
SET enable_seqscan = off
AS $$
BEGIN
  RETURN QUERY
    SELECT w.id, w.embedding <=> query_embedding AS dist
    FROM works w
    WHERE w.embedding IS NOT NULL
    ORDER BY w.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Variant B: drop the WHERE filter entirely (let HNSW return whatever it wants).
CREATE OR REPLACE FUNCTION probe_vec_nowhere(query_embedding extensions.vector(768), match_count int DEFAULT 10)
RETURNS TABLE (id text, dist float)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = extensions, public
AS $$
  SELECT id, embedding <=> query_embedding AS dist
  FROM works
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;

-- Variant C: try pgvector's iterative_scan setting (only effective if pgvector >= 0.8).
CREATE OR REPLACE FUNCTION probe_vec_iterative(query_embedding extensions.vector(768), match_count int DEFAULT 10)
RETURNS TABLE (id text, dist float)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = extensions, public
AS $$
BEGIN
  BEGIN
    EXECUTE 'SET LOCAL hnsw.iterative_scan = strict_order';
  EXCEPTION WHEN OTHERS THEN
    -- Older pgvector; setting doesn't exist
    NULL;
  END;
  RETURN QUERY
    SELECT w.id, w.embedding <=> query_embedding AS dist
    FROM works w
    WHERE w.embedding IS NOT NULL
    ORDER BY w.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Variant D: raise hnsw.ef_search to give the index a wider beam.
CREATE OR REPLACE FUNCTION probe_vec_ef200(query_embedding extensions.vector(768), match_count int DEFAULT 10)
RETURNS TABLE (id text, dist float)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = extensions, public
SET hnsw.ef_search = 200
AS $$
BEGIN
  RETURN QUERY
    SELECT w.id, w.embedding <=> query_embedding AS dist
    FROM works w
    WHERE w.embedding IS NOT NULL
    ORDER BY w.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION probe_vec_noseqscan(extensions.vector(768), int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION probe_vec_noseqscan(extensions.vector(768), int) TO service_role;
REVOKE EXECUTE ON FUNCTION probe_vec_nowhere(extensions.vector(768), int)   FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION probe_vec_nowhere(extensions.vector(768), int)   TO service_role;
REVOKE EXECUTE ON FUNCTION probe_vec_iterative(extensions.vector(768), int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION probe_vec_iterative(extensions.vector(768), int) TO service_role;
REVOKE EXECUTE ON FUNCTION probe_vec_ef200(extensions.vector(768), int)     FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION probe_vec_ef200(extensions.vector(768), int)     TO service_role;

NOTIFY pgrst, 'reload schema';
