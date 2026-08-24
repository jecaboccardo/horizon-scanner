-- Migration: fuzzy cross-source deduplication (pass 2)
--
-- Creates helper functions, then in a separate transaction finds duplicate
-- pairs (normalized title match, pub-type preference), inherits metadata,
-- and marks shadows. Chains (A→B→C) are resolved so only the ultimate
-- canonical survives.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Helper functions (outside transaction so they survive any later failure)
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.normalize_title(t text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(trim(t)),
          '\s*\((en|es|pt|fr)\)\s*$', '', 'g'),
        '[-‐‑‒–—]+', ' ', 'g'),
      '[^a-z0-9 ]', '', 'g'),
    '\s+', ' ', 'g');
$$;

CREATE OR REPLACE FUNCTION public.pub_type_rank(pt text)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE pt
    WHEN 'journal_article'  THEN 1
    WHEN 'discussion_paper' THEN 2
    WHEN 'working_paper'    THEN 3
    WHEN 'report'           THEN 4
    WHEN 'institutional'    THEN 5
    WHEN 'preprint'         THEN 6
    ELSE 99 END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Build pairs table
-- ────────────────────────────────────────────────────────────────────────────
CREATE TEMP TABLE _fuzzy_pairs (
  shadow_id    text PRIMARY KEY,
  canonical_id text NOT NULL
);

-- 2a. Fuzzy match: same normalized title, year ±8, shadow has lower-preference type.
--     Guards:
--       - Title must be ≥30 chars after normalisation (blocks "Introduction",
--         "Editors Introduction", "Reply", etc.)
--       - When BOTH papers have non-empty author arrays, the first author's last
--         name must match (handles name-format variants: "D. Autor" = "David Autor")
INSERT INTO _fuzzy_pairs
SELECT DISTINCT ON (a.id) a.id, b.id
FROM works a
JOIN works b
  ON  normalize_title(a.title) = normalize_title(b.title)
  AND length(normalize_title(a.title)) >= 30
  AND a.id  <> b.id
  AND a.is_noise = false
  AND b.is_noise = false
  AND a.canonical_work_id IS NULL
  AND b.canonical_work_id IS NULL
  AND pub_type_rank(a.publication_type) > pub_type_rank(b.publication_type)
  AND ABS(COALESCE(a.year, 0) - COALESCE(b.year, 0)) <= 8
  -- Author guard: if both have authors, first author last name must match
  AND (
    jsonb_array_length(a.authors) = 0 OR jsonb_array_length(b.authors) = 0
    OR lower(regexp_replace(trim(split_part((a.authors->0 #>> '{}'), ' ', -1)), '[^a-z]', '', 'g'))
       = lower(regexp_replace(trim(split_part((b.authors->0 #>> '{}'), ' ', -1)), '[^a-z]', '', 'g'))
  )
ORDER BY a.id, pub_type_rank(b.publication_type)
ON CONFLICT (shadow_id) DO NOTHING;

-- 2b. "Research Insights:" IDB briefs
INSERT INTO _fuzzy_pairs
SELECT DISTINCT ON (ri.id) ri.id, fp.id
FROM works ri
JOIN works fp
  ON  normalize_title(regexp_replace(ri.title, '^[Rr]esearch [Ii]nsights\s*:\s*', ''))
        = normalize_title(fp.title)
  AND ri.id <> fp.id
  AND ri.is_noise = false AND fp.is_noise = false
  AND ri.canonical_work_id IS NULL AND fp.canonical_work_id IS NULL
  AND ABS(COALESCE(ri.year, 0) - COALESCE(fp.year, 0)) <= 4
  AND pub_type_rank(fp.publication_type) <= pub_type_rank(ri.publication_type)
WHERE ri.title ILIKE 'Research Insights:%'
ORDER BY ri.id, pub_type_rank(fp.publication_type)
ON CONFLICT (shadow_id) DO NOTHING;

-- 2c. Break chains: if a canonical_id is itself a shadow_id in the table,
--     remove the weaker link so we don't create circular/chained references.
DELETE FROM _fuzzy_pairs
WHERE canonical_id IN (SELECT shadow_id FROM _fuzzy_pairs);

-- 2d. Remove pairs where shadow already has canonical_work_id in live DB
DELETE FROM _fuzzy_pairs
WHERE shadow_id IN (SELECT id FROM works WHERE canonical_work_id IS NOT NULL);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Apply in a transaction
-- ────────────────────────────────────────────────────────────────────────────
BEGIN;

-- Metadata: abstract
UPDATE works c SET abstract = s.abstract
FROM _fuzzy_pairs p JOIN works s ON s.id = p.shadow_id
WHERE c.id = p.canonical_id AND c.abstract IS NULL AND s.abstract IS NOT NULL;

-- Metadata: authors (jsonb)
UPDATE works c SET authors = s.authors
FROM _fuzzy_pairs p JOIN works s ON s.id = p.shadow_id
WHERE c.id = p.canonical_id
  AND (c.authors IS NULL OR jsonb_array_length(c.authors) = 0)
  AND s.authors IS NOT NULL AND jsonb_array_length(s.authors) > 0;

-- Metadata: geography (text[])
UPDATE works c SET geography = s.geography
FROM _fuzzy_pairs p JOIN works s ON s.id = p.shadow_id
WHERE c.id = p.canonical_id
  AND (c.geography IS NULL OR cardinality(c.geography) = 0)
  AND s.geography IS NOT NULL AND cardinality(s.geography) > 0;

-- Metadata: citation_count (MAX)
UPDATE works c SET citation_count = s.citation_count
FROM _fuzzy_pairs p JOIN works s ON s.id = p.shadow_id
WHERE c.id = p.canonical_id
  AND COALESCE(s.citation_count, 0) > COALESCE(c.citation_count, 0);

-- Remove shadows from pgvector ANN index
UPDATE works SET embedding = NULL
FROM _fuzzy_pairs p WHERE works.id = p.shadow_id;

-- Mark shadows
UPDATE works SET canonical_work_id = p.canonical_id
FROM _fuzzy_pairs p
WHERE works.id = p.shadow_id AND works.canonical_work_id IS NULL;

-- Remove shadows from extraction queue
DELETE FROM extraction_queue eq
USING works w
WHERE eq.work_id = w.id AND w.canonical_work_id IS NOT NULL AND eq.state <> 'done';

COMMIT;

-- Summary
SELECT COUNT(*) AS pairs_deduped FROM _fuzzy_pairs;

SELECT
  COUNT(*) FILTER (WHERE canonical_work_id IS NOT NULL) AS total_shadows,
  COUNT(*) FILTER (WHERE canonical_work_id IS NULL AND is_noise = false) AS total_canonicals
FROM works;
