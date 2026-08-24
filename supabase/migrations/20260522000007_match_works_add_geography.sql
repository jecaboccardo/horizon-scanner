-- Migration: add geography (+ publication_type, source_family, venue_kind) to match_works
--
-- match_works was filtering on geography (WHERE geography && filter_regions) but
-- NOT returning it in the SELECT — so every Paper from retrieval had geography=[]
-- regardless of what the DB held. 26% of canonical papers have geography populated;
-- none of it was reaching evidence rows or the evidence table display.
--
-- match_works_v2 already returned publication_type/source_family/venue_kind (added
-- in 20260515); match_works (the non-filtered sibling) was still missing them too.
-- Adding all four missing fields to both functions.

-- ---------------------------------------------------------------------------
-- match_works
-- ---------------------------------------------------------------------------
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
  scl_topics text[], geography text[],
  publication_type text, source_family text, venue_kind text,
  similarity float, fts_rank float
)
LANGUAGE sql STABLE
SET search_path = extensions, public
AS $$
  WITH
    vector_candidates AS (
      SELECT id,
        1 - (embedding <=> query_embedding) AS similarity,
        embedding <=> query_embedding       AS dist
      FROM works
      WHERE embedding IS NOT NULL
        AND excluded          IS NOT TRUE
        AND is_noise          IS NOT TRUE
        AND canonical_work_id IS NULL
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
      SELECT id,
        ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) AS fts_score
      FROM works
      WHERE query_text IS NOT NULL
        AND length(trim(query_text)) > 0
        AND fts_vector @@ websearch_to_tsquery('english', query_text)
        AND excluded          IS NOT TRUE
        AND is_noise          IS NOT TRUE
        AND canonical_work_id IS NULL
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
    COALESCE(w.geography, '{}')  AS geography,
    w.publication_type, w.source_family, w.venue_kind,
    r.similarity, r.fts_rank
  FROM rrf r
  JOIN works w ON w.id = r.id
  ORDER BY r.rrf_score DESC
  LIMIT match_count;
$$;

-- ---------------------------------------------------------------------------
-- match_works_v2 — add geography to SELECT (was in WHERE but not SELECT)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.match_works_v2(
  extensions.vector, text, float, int, int, int,
  text[], text[], text[], text[], text[], int, text[], float, text[]
);

CREATE OR REPLACE FUNCTION public.match_works_v2(
  query_embedding          extensions.vector(768),
  query_text               text,
  match_threshold          float    DEFAULT 0.55,
  match_count              int      DEFAULT 50,
  filter_min_year          int      DEFAULT NULL,
  filter_max_year          int      DEFAULT NULL,
  filter_venue_exact       text[]   DEFAULT NULL,
  filter_venue_patterns    text[]   DEFAULT NULL,
  filter_publication_types text[]   DEFAULT NULL,
  filter_topics            text[]   DEFAULT NULL,
  filter_regions           text[]   DEFAULT NULL,
  filter_sms_min           int      DEFAULT NULL,
  filter_abs_ratings       text[]   DEFAULT NULL,
  filter_repec_min_pct     float    DEFAULT NULL,
  filter_source_families   text[]   DEFAULT NULL
)
RETURNS TABLE (
  id text, title text, abstract text, year int, citation_count int,
  canonical_doi text, authors text[], publication_date text,
  is_open_access bool, open_access_pdf_url text, fields_of_study text[],
  venue text, journal_issn text, url text, source text,
  sms_level int, methodology_design text, causal_strength text,
  abs_rating text, repec_percentile float, corpus_source text,
  publication_type text, publication_type_method text,
  publication_type_confidence float, source_family text, venue_kind text,
  scl_topics text[], geography text[], similarity float, fts_rank float
)
LANGUAGE sql STABLE
SET search_path = extensions, public
AS $$
  WITH
    vector_candidates AS (
      SELECT id,
        1 - (embedding <=> query_embedding) AS similarity,
        embedding <=> query_embedding       AS dist
      FROM works
      WHERE embedding IS NOT NULL
        AND excluded          IS NOT TRUE
        AND is_noise          IS NOT TRUE
        AND canonical_work_id IS NULL
        AND (filter_min_year IS NULL OR year >= filter_min_year)
        AND (filter_max_year IS NULL OR year <= filter_max_year)
        AND (
          (filter_venue_exact IS NULL AND filter_venue_patterns IS NULL AND filter_source_families IS NULL)
          OR (filter_venue_exact     IS NOT NULL AND venue = ANY(filter_venue_exact))
          OR (filter_venue_patterns  IS NOT NULL AND venue ILIKE ANY(filter_venue_patterns))
          OR (filter_source_families IS NOT NULL AND source_family = ANY(filter_source_families))
        )
        AND (filter_publication_types IS NULL OR publication_type = ANY(filter_publication_types) OR publication_type IS NULL)
        AND (filter_topics IS NULL OR scl_topics && filter_topics OR scl_topics IS NULL OR cardinality(scl_topics) = 0)
        AND (filter_regions IS NULL OR geography && filter_regions OR geography IS NULL)
        AND (filter_sms_min IS NULL OR sms_level >= filter_sms_min OR sms_level IS NULL)
        AND (filter_abs_ratings IS NULL OR abs_rating = ANY(filter_abs_ratings) OR abs_rating IS NULL)
        AND (filter_repec_min_pct IS NULL OR repec_percentile <= filter_repec_min_pct OR repec_percentile IS NULL)
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
      SELECT id,
        ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) AS fts_score
      FROM works
      WHERE query_text IS NOT NULL
        AND length(trim(query_text)) > 0
        AND fts_vector @@ websearch_to_tsquery('english', query_text)
        AND excluded          IS NOT TRUE
        AND is_noise          IS NOT TRUE
        AND canonical_work_id IS NULL
        AND (filter_min_year IS NULL OR year >= filter_min_year)
        AND (filter_max_year IS NULL OR year <= filter_max_year)
        AND (
          (filter_venue_exact IS NULL AND filter_venue_patterns IS NULL AND filter_source_families IS NULL)
          OR (filter_venue_exact     IS NOT NULL AND venue = ANY(filter_venue_exact))
          OR (filter_venue_patterns  IS NOT NULL AND venue ILIKE ANY(filter_venue_patterns))
          OR (filter_source_families IS NOT NULL AND source_family = ANY(filter_source_families))
        )
        AND (filter_publication_types IS NULL OR publication_type = ANY(filter_publication_types) OR publication_type IS NULL)
        AND (filter_topics IS NULL OR scl_topics && filter_topics OR scl_topics IS NULL OR cardinality(scl_topics) = 0)
        AND (filter_regions IS NULL OR geography && filter_regions OR geography IS NULL)
        AND (filter_sms_min IS NULL OR sms_level >= filter_sms_min OR sms_level IS NULL)
        AND (filter_abs_ratings IS NULL OR abs_rating = ANY(filter_abs_ratings) OR abs_rating IS NULL)
        AND (filter_repec_min_pct IS NULL OR repec_percentile <= filter_repec_min_pct OR repec_percentile IS NULL)
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
    w.publication_type, w.publication_type_method,
    w.publication_type_confidence::float, w.source_family, w.venue_kind,
    COALESCE(w.scl_topics,  '{}') AS scl_topics,
    COALESCE(w.geography,   '{}') AS geography,
    r.similarity, r.fts_rank
  FROM rrf r
  JOIN works w ON w.id = r.id
  ORDER BY r.rrf_score DESC
  LIMIT match_count;
$$;

COMMENT ON FUNCTION public.match_works_v2 IS
  '2026-05-22 geography added to SELECT (was filter-only). Both functions now '
  'return geography so evidence rows carry correct country/region data.';

NOTIFY pgrst, 'reload schema';
