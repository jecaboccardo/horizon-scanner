-- Migration: is_noise flag for non-research / journal-admin content
--
-- Adds is_noise + noise_reason to works. Noise papers are:
--   - Excluded from retrieval (match_works + match_works_v2 updated below)
--   - Not prioritised for abstract backfill or evidence card extraction
--   - Hidden from the evidence table by default
--   - Removed from the extraction queue (if not yet done)
--
-- Distinct from `excluded` (which is manual admin suppression).
-- noise_reason values:
--   book_review, correction_retraction, obituary_award, vacancy_announcement,
--   index_front_matter, generic_section_header, forthcoming, issue_information,
--   election_fellows, author_instructions, list_members, editorial,
--   comment_discussion, admin_report, foreword_preface, meeting_admin,
--   new_books_received, subscription_contents, referee_acknowledgement

-- ---------------------------------------------------------------------------
-- 1. Add columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.works
  ADD COLUMN IF NOT EXISTS is_noise  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS noise_reason text;

CREATE INDEX IF NOT EXISTS idx_works_is_noise
  ON public.works (is_noise)
  WHERE is_noise = true;

-- ---------------------------------------------------------------------------
-- 2. Tier 1 — very safe, auto-flag
-- ---------------------------------------------------------------------------

-- Book reviews
UPDATE public.works SET is_noise = true, noise_reason = 'book_review'
WHERE is_noise = false
  AND (
    title ILIKE 'book review%'
    OR title ILIKE 'book reviews%'
    OR title ~* '^reviews? of books?'
    OR title ~* '\mbook reviews?\M' AND length(title) < 40
  );

-- Corrections, errata, retractions
UPDATE public.works SET is_noise = true, noise_reason = 'correction_retraction'
WHERE is_noise = false
  AND (
    title ~* '\merrata\M'
    OR title ~* '\mcorrigendum\M'
    OR title ~* '\mcorrigenda\M'
    OR title ~* '\bretraction of\b'
    OR title ~* '^retracted:'
    OR title ~* '\bretracted article\b'
  );

-- Obituaries and in memoriam
UPDATE public.works SET is_noise = true, noise_reason = 'obituary_award'
WHERE is_noise = false
  AND (
    title ~* '\bin memoriam\b'
    OR title ~* '\bobituary\b'
    OR title ~* '\bobituaries\b'
  );

-- Job vacancies and fellowship announcements (very specific)
UPDATE public.works SET is_noise = true, noise_reason = 'vacancy_announcement'
WHERE is_noise = false
  AND (
    title ~* '\bjob vacanc'
    OR title ~* '\bvacancy announcement\b'
    OR title ~* '\bposition (open|available|announcement)\b'
    OR title ~* '\bcall for (papers|submissions|nominations|proposals)\b'
  );

-- Front matter, back matter, index pages
UPDATE public.works SET is_noise = true, noise_reason = 'index_front_matter'
WHERE is_noise = false
  AND (
    title ~* '^front matter'
    OR title ~* '^back matter'
    OR title ~ '^Index to [Vv]olume'
    OR title ~ '^Index to [Vv]ol\.'
    OR title ~ '^Index, [Vv]olume'
    OR title ILIKE 'Table of Contents%'
    OR title ILIKE 'Issue Information%'
    OR title ILIKE 'Issue Information'
    OR title ~* '^journal information\b'
  );

-- Generic section-header titles (exact matches only — too short/generic to be papers)
UPDATE public.works SET is_noise = true, noise_reason = 'generic_section_header'
WHERE is_noise = false
  AND title = ANY(ARRAY[
    'Introduction', 'Conclusion', 'Conclusions', 'Summary', 'Overview',
    'Discussion', 'General Discussion', 'Comment and Discussion',
    'Comments and Discussion', 'Comments', 'Front Matter', 'Back Matter',
    'Preface', 'Foreword', 'Editors'' Summary', 'Editor''s Summary',
    'Editors'' Introduction', 'Abstract', 'Abstracts'
  ]);

-- Forthcoming papers/articles pages
UPDATE public.works SET is_noise = true, noise_reason = 'forthcoming'
WHERE is_noise = false
  AND (
    title ILIKE 'forthcoming papers%'
    OR title ILIKE 'forthcoming articles%'
    OR title ILIKE 'forthcoming%' AND length(title) < 30
  );

-- Elections of fellows/members to learned societies
UPDATE public.works SET is_noise = true, noise_reason = 'election_fellows'
WHERE is_noise = false
  AND (
    title ~* '\belection of (fellows|members|officers)\b'
    OR title ~* '\belected fellows?\b'
    OR title ~* '\belected members?\b'
    OR title ~* 'fellows? of the (econometric|economic|statistical|american finance) (society|association)'
  );

-- Author instructions / submission guidelines
UPDATE public.works SET is_noise = true, noise_reason = 'author_instructions'
WHERE is_noise = false
  AND (
    title ~* '\bnotes for contributors\b'
    OR title ~* '\binformation for authors\b'
    OR title ~* '\binstructions (to|for) authors\b'
    OR title ~* '\bguide for authors\b'
    OR title ~* '\bsubmission guidelines\b'
    OR title ~* '\bmanuscript submission\b'
  );

-- List of members / referees / reviewers
UPDATE public.works SET is_noise = true, noise_reason = 'list_members'
WHERE is_noise = false
  AND (
    title ~* '\blist of (members|fellows|referees|reviewers|editors)\b'
    OR title ~* '\backnowledgment of referees\b'
    OR title ~* '\backnowledgment of reviewers\b'
    OR title ~* '\backnowledgement of referees\b'
    OR title ~* '\bthanks to (our )?(referees|reviewers)\b'
  );

-- ---------------------------------------------------------------------------
-- 3. Tier 2 — safe, confirmed by sampling
-- ---------------------------------------------------------------------------

-- Editorials (title starts with "Editorial")
UPDATE public.works SET is_noise = true, noise_reason = 'editorial'
WHERE is_noise = false
  AND (
    title ~* '^editorial\b'
    OR title ILIKE 'editorial board%'
    OR title ILIKE 'editorial introduction%'
  );

-- Comments, replies, rejoinders to specific papers (not research)
UPDATE public.works SET is_noise = true, noise_reason = 'comment_discussion'
WHERE is_noise = false
  AND (
    title ~* '^comments? and discussion\b'
    OR title ~* '^reply to\b'
    OR title ~* '^response to\b'
    OR title ~* '^rejoinder to\b'
    OR title ~* '^a (reply|response|rejoinder) to\b'
    OR title ~* '^discussion of\b'
    OR title ~* '^comment on\b'
    OR title = 'Comment and Discussion'
    OR title = 'Comments and Discussion'
  );

-- Committee / officer reports (treasurer, secretary, editor, program)
UPDATE public.works SET is_noise = true, noise_reason = 'admin_report'
WHERE is_noise = false
  AND (
    title ~* '\breport of the (secretary|treasurer|editor|program committee)\b'
    OR title ~* '\btreasurer.s report\b'
    OR title ~* '\bsecretary.s report\b'
    OR title ~* '\bannual report of the\b'
    OR title ~* '\beditor.s report\b'
    OR title ~* '\bpresident.s report\b'
  );

-- Forewords and prefaces (that aren't research)
UPDATE public.works SET is_noise = true, noise_reason = 'foreword_preface'
WHERE is_noise = false
  AND (
    title ~* '^foreword\b'
    OR title ~* '^preface\b'
    OR title ~* '^(a |an )?(foreword|preface) (to|by|for)\b'
  );

-- Annual meetings, presidential addresses, conference programmes
UPDATE public.works SET is_noise = true, noise_reason = 'meeting_admin'
WHERE is_noise = false
  AND (
    title ~* '\bannual meeting of the\b'
    OR title ~* '\bpreliminary program.{0,20}annual meeting\b'
    OR title ~* '\bdates and locations of forthcoming.{0,30}meetings\b'
    OR title ~* '\bpresidential address\b' AND length(title) < 60
  );

-- New books received / publications received
UPDATE public.works SET is_noise = true, noise_reason = 'new_books_received'
WHERE is_noise = false
  AND (
    title ~* '^new books?\b'
    OR title ~* '^books? received\b'
    OR title ~* '^recent publications\b'
    OR title ~* '^publications received\b'
    OR title ~* '^annotated listing of new books\b'
    OR title = 'New Books'
    OR title = 'Books Received'
  );

-- Subscription / volume information
UPDATE public.works SET is_noise = true, noise_reason = 'subscription_contents'
WHERE is_noise = false
  AND (
    title ~* '^subscription information\b'
    OR title ~* '^volume information\b'
    OR title ILIKE 'contents%' AND length(title) < 20
  );

-- ---------------------------------------------------------------------------
-- 4. Summary counts (logged by psql)
-- ---------------------------------------------------------------------------

SELECT noise_reason, COUNT(*) as flagged
FROM public.works
WHERE is_noise = true
GROUP BY noise_reason
ORDER BY flagged DESC;

SELECT COUNT(*) as total_noise FROM public.works WHERE is_noise = true;
SELECT COUNT(*) as noise_no_abstract FROM public.works WHERE is_noise = true AND abstract IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Remove noise papers from extraction queue (don't waste worker time)
-- ---------------------------------------------------------------------------

DELETE FROM public.extraction_queue eq
USING public.works w
WHERE eq.work_id = w.id
  AND w.is_noise = true
  AND eq.state != 'done';

-- ---------------------------------------------------------------------------
-- 6. Update match_works to filter is_noise
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
        AND 1 - (embedding <=> query_embedding) > match_threshold
      ORDER BY embedding <=> query_embedding
      LIMIT match_count * 2
    ),
    vector_hits AS (
      SELECT
        id, similarity,
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
      ORDER BY ts_rank_cd(fts_vector, websearch_to_tsquery('english', query_text)) DESC
      LIMIT match_count * 2
    ),
    fts_hits AS (
      SELECT
        id, fts_score,
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
    AND w.is_noise IS NOT TRUE
  ORDER BY r.rrf_score DESC
  LIMIT match_count;
$$;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 7. Update match_works_v2 to also filter is_noise
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
        AND is_noise IS NOT TRUE
        AND (filter_min_year IS NULL OR year >= filter_min_year)
        AND (filter_max_year IS NULL OR year <= filter_max_year)
        AND (
          (filter_venue_exact IS NULL AND filter_venue_patterns IS NULL AND filter_source_families IS NULL)
          OR (filter_venue_exact     IS NOT NULL AND venue = ANY(filter_venue_exact))
          OR (filter_venue_patterns  IS NOT NULL AND venue ILIKE ANY(filter_venue_patterns))
          OR (filter_source_families IS NOT NULL AND source_family = ANY(filter_source_families))
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
        AND is_noise IS NOT TRUE
        AND (filter_min_year IS NULL OR year >= filter_min_year)
        AND (filter_max_year IS NULL OR year <= filter_max_year)
        AND (
          (filter_venue_exact IS NULL AND filter_venue_patterns IS NULL AND filter_source_families IS NULL)
          OR (filter_venue_exact     IS NOT NULL AND venue = ANY(filter_venue_exact))
          OR (filter_venue_patterns  IS NOT NULL AND venue ILIKE ANY(filter_venue_patterns))
          OR (filter_source_families IS NOT NULL AND source_family = ANY(filter_source_families))
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
    w.publication_type, w.publication_type_method,
    w.publication_type_confidence::float, w.source_family, w.venue_kind,
    COALESCE(w.scl_topics, '{}') AS scl_topics,
    r.similarity, r.fts_rank
  FROM rrf r
  JOIN works w ON w.id = r.id
  WHERE w.excluded IS NOT TRUE
    AND w.is_noise IS NOT TRUE
  ORDER BY r.rrf_score DESC
  LIMIT match_count;
$$;

COMMENT ON FUNCTION public.match_works_v2 IS
  '2026-05-22 adds is_noise filter alongside excluded; pre-filtered hybrid retrieval with source_family filters plus venue/publication metadata.';

NOTIFY pgrst, 'reload schema';
