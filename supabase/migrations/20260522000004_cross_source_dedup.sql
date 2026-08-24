-- Migration: cross-source deduplication — working_paper shadow → journal_article canonical
-- 3,128 unambiguous pairs (1:1 title match within 8yr window).
-- Passes: inherit abstract, geography, citation_count (MAX), then mark shadows.

BEGIN;

-- Helper view used across passes
CREATE TEMP VIEW _xsource_pairs AS
  SELECT wp.id AS shadow_id, pub.id AS canonical_id
  FROM works wp
  JOIN works pub ON wp.title = pub.title
  WHERE wp.publication_type  = 'working_paper'
    AND pub.publication_type = 'journal_article'
    AND wp.id  != pub.id
    AND wp.is_noise  = false
    AND pub.is_noise = false
    AND wp.canonical_work_id  IS NULL
    AND pub.canonical_work_id IS NULL
    AND ABS(COALESCE(wp.year,0) - COALESCE(pub.year,0)) <= 8
    AND wp.id IN (
      SELECT s FROM (
        SELECT wp2.id AS s FROM works wp2
        JOIN works pub2 ON wp2.title = pub2.title
        WHERE wp2.publication_type='working_paper' AND pub2.publication_type='journal_article'
          AND wp2.id!=pub2.id AND wp2.is_noise=false AND pub2.is_noise=false
          AND wp2.canonical_work_id IS NULL AND pub2.canonical_work_id IS NULL
          AND ABS(COALESCE(wp2.year,0)-COALESCE(pub2.year,0))<=8
        GROUP BY wp2.id HAVING COUNT(*)=1
      ) u
    )
    AND pub.id IN (
      SELECT c FROM (
        SELECT pub2.id AS c FROM works wp2
        JOIN works pub2 ON wp2.title = pub2.title
        WHERE wp2.publication_type='working_paper' AND pub2.publication_type='journal_article'
          AND wp2.id!=pub2.id AND wp2.is_noise=false AND pub2.is_noise=false
          AND wp2.canonical_work_id IS NULL AND pub2.canonical_work_id IS NULL
          AND ABS(COALESCE(wp2.year,0)-COALESCE(pub2.year,0))<=8
        GROUP BY pub2.id HAVING COUNT(*)=1
      ) u
    );

-- 1. Inherit abstract
UPDATE works canonical
SET abstract = shadow.abstract
FROM _xsource_pairs p
JOIN works shadow ON shadow.id = p.shadow_id
WHERE canonical.id = p.canonical_id
  AND canonical.abstract IS NULL
  AND shadow.abstract IS NOT NULL;

-- 2. Inherit geography
UPDATE works canonical
SET geography = shadow.geography
FROM _xsource_pairs p
JOIN works shadow ON shadow.id = p.shadow_id
WHERE canonical.id = p.canonical_id
  AND (canonical.geography IS NULL OR cardinality(canonical.geography) = 0)
  AND shadow.geography IS NOT NULL AND cardinality(shadow.geography) > 0;

-- 3. Inherit citation count (MAX)
UPDATE works canonical
SET citation_count = shadow.citation_count
FROM _xsource_pairs p
JOIN works shadow ON shadow.id = p.shadow_id
WHERE canonical.id = p.canonical_id
  AND COALESCE(shadow.citation_count, 0) > COALESCE(canonical.citation_count, 0);

-- 4. Mark shadow rows
UPDATE works
SET canonical_work_id = p.canonical_id
FROM _xsource_pairs p
WHERE works.id = p.shadow_id
  AND works.canonical_work_id IS NULL;

-- 5. Remove shadows from extraction queue
DELETE FROM extraction_queue eq
USING works w
WHERE eq.work_id = w.id
  AND w.canonical_work_id IS NOT NULL
  AND eq.state != 'done';

COMMIT;

-- Summary
SELECT
  COUNT(*) FILTER (WHERE canonical_work_id IS NOT NULL) AS total_shadows,
  COUNT(*) FILTER (WHERE canonical_work_id IS NULL AND is_noise = false) AS total_canonicals
FROM works;
