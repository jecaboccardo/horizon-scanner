-- 2026-05-13 — match_works_v2: pre-filtered hybrid retrieval.
--
-- SIBLING of match_works, NOT a replacement. The original match_works
-- function is untouched and remains the production RPC until callers are
-- migrated behind a feature flag (USE_PREFILTERED_MATCH_WORKS).
--
-- All filter params default NULL ⇒ when called with no filters, v2 mimics
-- match_works' current behavior (universe = full corpus) except for two
-- differences inherited by design:
--   1) v2 does NOT force HNSW via SET hnsw.ef_search / SET enable_seqscan.
--      Lessons from 2026-05-12 recall crisis — recall must be measured first.
--   2) v2 keeps the same CTE shape as match_works (f457c2b) so LIMIT pushdown
--      still works for any indexes the planner does choose.
--
-- Pre-filter design rules:
--   Hard predicates on fully-populated indexed columns (year, publication_type).
--   Soft predicates on sparse columns (SMS, ABS, topics, regions, geography):
--     pattern "(filter IS NULL OR matches OR value IS NULL/empty)" so
--     unclassified papers are not silently dropped.
--   Venue is NOT in the default pre-filter. Venue quality is enforced
--     post-retrieval by the TypeScript scoring layer. Venue params exist
--     on this function for EXPLICIT user selections (user picked a specific
--     journal, institution, or WP source in the UI) — never as invisible defaults.
--   Inferred venue quality (tier 1+2, institution) → never a hard pre-filter.
--
-- Coverage references (computed 2026-05-13 on 622,935 rows):
--   year             100%   abs_rating        31%
--   scl_topics        100%   repec_percentile  37%
--   venue              99%   publication_type  77%
--   geography          83%   sms_level         24%

CREATE OR REPLACE FUNCTION match_works_v2(
  query_embedding         extensions.vector(768),
  query_text              text,
  match_threshold         float    DEFAULT 0.55,
  match_count             int      DEFAULT 50,
  -- Pre-filter params. NULL = no constraint on that dimension.
  filter_min_year         int      DEFAULT NULL,
  filter_max_year         int      DEFAULT NULL,
  filter_venue_exact      text[]   DEFAULT NULL,   -- tier-1/2 journal names
  filter_venue_patterns   text[]   DEFAULT NULL,   -- ILIKE patterns for institutions/WP hosts
  filter_publication_types text[]  DEFAULT NULL,
  filter_topics           text[]   DEFAULT NULL,   -- scl_topics overlap
  filter_regions          text[]   DEFAULT NULL,   -- geography overlap
  filter_sms_min          int      DEFAULT NULL,   -- soft: sms_level >= X OR IS NULL
  filter_abs_ratings      text[]   DEFAULT NULL,   -- soft: abs_rating IN (...) OR IS NULL
  filter_repec_min_pct    float    DEFAULT NULL    -- soft: repec_percentile <= X OR IS NULL
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
    vector_candidates AS (
      SELECT
        id,
        1 - (embedding <=> query_embedding) AS similarity,
        embedding <=> query_embedding       AS dist
      FROM works
      WHERE embedding IS NOT NULL
        -- Hard predicates (fully-populated, indexed columns).
        AND (filter_min_year IS NULL OR year >= filter_min_year)
        AND (filter_max_year IS NULL OR year <= filter_max_year)
        AND (
          (filter_venue_exact IS NULL AND filter_venue_patterns IS NULL)
          OR (filter_venue_exact   IS NOT NULL AND venue = ANY(filter_venue_exact))
          OR (filter_venue_patterns IS NOT NULL AND venue ILIKE ANY(filter_venue_patterns))
        )
        -- Soft predicates (sparse columns, preserve NULL/empty rows).
        AND (
          filter_publication_types IS NULL
          OR publication_type = ANY(filter_publication_types)
          OR publication_type IS NULL
        )
        AND (
          filter_topics IS NULL
          OR scl_topics && filter_topics
          OR scl_topics IS NULL
          OR cardinality(scl_topics) = 0
        )
        AND (
          filter_regions IS NULL
          OR geography && filter_regions
          OR geography IS NULL
        )
        AND (
          filter_sms_min IS NULL
          OR sms_level >= filter_sms_min
          OR sms_level IS NULL
        )
        AND (
          filter_abs_ratings IS NULL
          OR abs_rating = ANY(filter_abs_ratings)
          OR abs_rating IS NULL
        )
        AND (
          filter_repec_min_pct IS NULL
          OR repec_percentile <= filter_repec_min_pct
          OR repec_percentile IS NULL
        )
        -- Vector similarity threshold (last — most expensive predicate).
        AND 1 - (embedding <=> query_embedding) > match_threshold
      ORDER BY embedding <=> query_embedding
      LIMIT match_count * 2
    ),
    vector_hits AS (
      SELECT id, similarity,
        ROW_NUMBER() OVER (ORDER BY dist) AS vector_rank
      FROM vector_candidates
    ),
    fts_candidates AS (
      SELECT
        id,
        ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) AS fts_score
      FROM works
      WHERE query_text IS NOT NULL
        AND length(trim(query_text)) > 0
        AND fts_vector @@ websearch_to_tsquery('english', query_text)
        -- Same pre-filters as the vector branch for symmetry.
        AND (filter_min_year IS NULL OR year >= filter_min_year)
        AND (filter_max_year IS NULL OR year <= filter_max_year)
        AND (
          (filter_venue_exact IS NULL AND filter_venue_patterns IS NULL)
          OR (filter_venue_exact   IS NOT NULL AND venue = ANY(filter_venue_exact))
          OR (filter_venue_patterns IS NOT NULL AND venue ILIKE ANY(filter_venue_patterns))
        )
        AND (
          filter_publication_types IS NULL
          OR publication_type = ANY(filter_publication_types)
          OR publication_type IS NULL
        )
        AND (
          filter_topics IS NULL
          OR scl_topics && filter_topics
          OR scl_topics IS NULL
          OR cardinality(scl_topics) = 0
        )
        AND (
          filter_regions IS NULL
          OR geography && filter_regions
          OR geography IS NULL
        )
        AND (
          filter_sms_min IS NULL
          OR sms_level >= filter_sms_min
          OR sms_level IS NULL
        )
        AND (
          filter_abs_ratings IS NULL
          OR abs_rating = ANY(filter_abs_ratings)
          OR abs_rating IS NULL
        )
        AND (
          filter_repec_min_pct IS NULL
          OR repec_percentile <= filter_repec_min_pct
          OR repec_percentile IS NULL
        )
      ORDER BY ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) DESC
      LIMIT match_count * 2
    ),
    fts_hits AS (
      SELECT id, fts_score,
        ROW_NUMBER() OVER (ORDER BY fts_score DESC) AS fts_rank_pos
      FROM fts_candidates
    ),
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

NOTIFY pgrst, 'reload schema';

COMMENT ON FUNCTION match_works_v2 IS
  '2026-05-13 sibling of match_works with optional SQL pre-filter params. '
  'All filter params default NULL = no constraint. Hard predicates on year and '
  'venue; soft predicates (preserve NULL/empty) on sparse columns: sms_level, '
  'abs_rating, repec_percentile, scl_topics, geography, publication_type. '
  'Validate via evals before swapping callers from match_works.';
