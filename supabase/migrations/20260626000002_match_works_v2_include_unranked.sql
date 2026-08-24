-- 20260626000002_match_works_v2_include_unranked.sql
-- Add an opt-in `filter_include_unranked` param to match_works_v2.
--
-- Context: the source-universe venue gate (vector + fts arms) is OR-combined over
-- {filter_venue_exact, filter_venue_patterns, filter_source_families}. By default a
-- search applies a HARD journal filter to the selected ABS tiers (e.g. ABS 3+), so a
-- relevant paper published in a journal with NO ABS rating (regional / specialist /
-- unranked venue) is dropped — and the UI had no way to opt those back in.
--
-- This adds a bounded disjunct: when filter_include_unranked = true, journal articles
-- whose venue carries no ABS rating (abs_rating IS NULL AND publication_type =
-- 'journal_article') ALSO pass the venue gate. It is ADDITIVE — the user's tier/
-- institutional/working-paper selections are unchanged; this only widens what passes.
-- Scoped to journal_article so it does NOT pull in working papers / reports / books
-- (those are governed by the separate institutional + working-paper source pickers).
--
-- Default false → byte-identical to the prior behaviour when the flag is off.
--
-- 🔴 Preserves the 2026-06-14 perf fix: vector_candidates + fts_candidates stay
-- MATERIALIZED and enable_seqscan is re-applied to the NEW 16-arg signature
-- (CLAUDE.md: re-apply both after any CREATE OR REPLACE of these RPCs).

-- Atomic swap: DROP + CREATE in one transaction so a concurrent search never
-- sees a missing match_works_v2 (it's the hot-path RPC).
BEGIN;

-- Drop the old 15-arg overload so only the new signature exists (avoids an
-- ambiguous-overload resolution when PostgREST omits the new defaulted param).
DROP FUNCTION IF EXISTS public.match_works_v2(
  vector, text, double precision, integer, integer, integer,
  text[], text[], text[], text[], text[], integer, text[], double precision, text[]
);

CREATE OR REPLACE FUNCTION public.match_works_v2(
  query_embedding vector,
  query_text text,
  match_threshold double precision DEFAULT 0.55,
  match_count integer DEFAULT 50,
  filter_min_year integer DEFAULT NULL::integer,
  filter_max_year integer DEFAULT NULL::integer,
  filter_venue_exact text[] DEFAULT NULL::text[],
  filter_venue_patterns text[] DEFAULT NULL::text[],
  filter_publication_types text[] DEFAULT NULL::text[],
  filter_topics text[] DEFAULT NULL::text[],
  filter_regions text[] DEFAULT NULL::text[],
  filter_sms_min integer DEFAULT NULL::integer,
  filter_abs_ratings text[] DEFAULT NULL::text[],
  filter_repec_min_pct double precision DEFAULT NULL::double precision,
  filter_source_families text[] DEFAULT NULL::text[],
  filter_include_unranked boolean DEFAULT false
)
 RETURNS TABLE(id text, title text, abstract text, year integer, citation_count integer, canonical_doi text, authors text[], publication_date text, is_open_access boolean, open_access_pdf_url text, fields_of_study text[], venue text, journal_issn text, url text, source text, sms_level integer, methodology_design text, causal_strength text, abs_rating text, repec_percentile double precision, corpus_source text, publication_type text, publication_type_method text, publication_type_confidence double precision, source_family text, venue_kind text, scl_topics text[], geography text[], similarity double precision, fts_rank double precision)
 LANGUAGE sql
 STABLE
 SET search_path TO 'extensions', 'public'
AS $function$
  WITH
    vector_candidates AS MATERIALIZED (
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
          OR (filter_include_unranked AND abs_rating IS NULL AND publication_type = 'journal_article')
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
    fts_candidates AS MATERIALIZED (
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
          OR (filter_include_unranked AND abs_rating IS NULL AND publication_type = 'journal_article')
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
$function$;

-- Re-apply the planner steer to the NEW 16-arg signature (see 20260614000001).
ALTER FUNCTION match_works_v2(vector,text,double precision,integer,integer,integer,text[],text[],text[],text[],text[],integer,text[],double precision,text[],boolean) SET enable_seqscan = off;

COMMIT;

NOTIFY pgrst, 'reload schema';
