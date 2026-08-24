-- 2026-05-12 — Rewrite match_works to actually use the HNSW + FTS indexes.
--
-- ROOT CAUSE diagnosed today: the previous CTE structure had
--   ROW_NUMBER() OVER (ORDER BY embedding <=> query_embedding)
-- inside the *same* CTE that also had ORDER BY ... LIMIT. Window functions
-- block LIMIT pushdown, so Postgres computed the distance for every row in
-- the table (622k × 768 dims) then sorted then LIMIT-ed. Same for FTS.
--
-- After this rewrite the indexed scan + LIMIT happens first, THEN the
-- window function (ROW_NUMBER for RRF) runs over only the ~match_count*2
-- rows in the result. The HNSW and GIN indexes become effective again.
--
-- Verified via probe-match-works-perf.mjs: previously ~28-30s flat
-- regardless of match_count. Expected post-fix: <2s.

CREATE OR REPLACE FUNCTION match_works(
  query_embedding extensions.vector(768),
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
  WITH
    -- Vector candidates: pure indexed scan + LIMIT, no window function.
    -- The HNSW index can serve `ORDER BY embedding <=> qv LIMIT N`
    -- as long as nothing in this CTE forces a full materialization.
    vector_candidates AS (
      SELECT
        id,
        1 - (embedding <=> query_embedding) AS similarity,
        embedding <=> query_embedding       AS dist
      FROM works
      WHERE embedding IS NOT NULL
        AND 1 - (embedding <=> query_embedding) > match_threshold
      ORDER BY embedding <=> query_embedding
      LIMIT match_count * 2
    ),
    -- Now (and only now) compute rank — over the small ~LIMIT set.
    vector_hits AS (
      SELECT
        id, similarity,
        ROW_NUMBER() OVER (ORDER BY dist) AS vector_rank
      FROM vector_candidates
    ),

    -- Same pattern for FTS: indexed predicate + ORDER BY + LIMIT first,
    -- then window function. Skip the path entirely if query_text is empty.
    fts_candidates AS (
      SELECT
        id,
        ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) AS fts_score
      FROM works
      WHERE query_text IS NOT NULL
        AND length(trim(query_text)) > 0
        AND fts_vector @@ websearch_to_tsquery('english', query_text)
      ORDER BY ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) DESC
      LIMIT match_count * 2
    ),
    fts_hits AS (
      SELECT
        id, fts_score,
        ROW_NUMBER() OVER (ORDER BY fts_score DESC) AS fts_rank_pos
      FROM fts_candidates
    ),

    -- Reciprocal Rank Fusion of the two small candidate sets.
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
