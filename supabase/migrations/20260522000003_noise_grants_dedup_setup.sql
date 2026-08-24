-- Migration: additional noise patterns + jel_papers grants + canonical_work_id setup
--
-- 1. Noise: exact-match journal-admin titles missed by previous migrations
-- 2. jel_papers: GRANT to API roles (was missing, caused "permission denied")
-- 3. canonical_work_id: new column for deduplication (shadow → canonical pointer)

-- ---------------------------------------------------------------------------
-- 1. More noise — exact-match journal section/admin titles
-- ---------------------------------------------------------------------------
-- These appear 13-17 times per year in OpenAlex across journals: they are
-- journal cover pages, reply sections, contributor lists, etc. that OpenAlex
-- indexed as individual articles.

UPDATE public.works SET is_noise = true, noise_reason = 'generic_section_header'
WHERE is_noise = false AND title = ANY(ARRAY[
  -- Cover pages (journals publish these as DOI-bearing "articles")
  'Cover', 'Covers', 'Back Cover', 'Front Cover',
  -- Contributor/member lists
  'Contributors', 'List of Contributors', 'About the Contributors',
  'Members', 'Officers', 'Officers and Members',
  -- Short reply/comment stubs (longer ones caught by comment_discussion pattern)
  'Reply', 'Replies', 'Comment', 'Comments',
  -- Subscription and journal-info pages
  'Subscription Page', 'Subscription Information',
  'Editorial Advisory Board', 'Advisory Board', 'Editorial Board',
  'Board of Editors', 'Board of Directors',
  -- No-title placeholders from metadata systems
  '[NO TITLE AVAILABLE]', '[No title available]', 'N/A',
  -- Forthcoming / papers to appear variants not caught by ^forthcoming pattern
  'Papers to Appear in Forthcoming Issues',
  'Forthcoming', 'Forthcoming Papers',
  -- Other journal-admin stubs
  'Notes', 'Note', 'Notices', 'Erratum', 'Errata',
  'Contents', 'Table of Contents',
  'Masthead', 'Colophon',
  'Abstracts', 'Abstract',
  'Appendix', 'Appendices',
  'Acknowledgements', 'Acknowledgments',
  'References', 'Bibliography',
  'Author Index', 'Subject Index', 'Index',
  'List of Figures', 'List of Tables',
  'Introduction', 'Conclusion', 'Conclusions',
  'Summary', 'Overview', 'Discussion',
  'Preface', 'Foreword',
  'Front Matter', 'Back Matter',
  'Editors'' Summary', 'Editor''s Summary'
]);

-- Slightly broader: short titles that are clearly section stubs
-- Only flag if very short (≤2 words) AND no abstract AND no citation count
UPDATE public.works SET is_noise = true, noise_reason = 'generic_section_header'
WHERE is_noise = false
  AND abstract IS NULL
  AND (citation_count IS NULL OR citation_count = 0)
  AND array_length(regexp_split_to_array(trim(title), '\s+'), 1) <= 2
  AND title ~ '^[A-Z][a-z]'          -- title-cased (not an acronym)
  AND title !~ '\d'                  -- no numbers (would exclude "Table 1", etc. but also legit short titles)
  AND length(title) BETWEEN 3 AND 20;

-- Remove newly flagged noise from extraction queue
DELETE FROM public.extraction_queue eq
USING public.works w
WHERE eq.work_id = w.id
  AND w.is_noise = true
  AND eq.state != 'done';

SELECT noise_reason, COUNT(*) FROM public.works WHERE is_noise = true
GROUP BY noise_reason ORDER BY COUNT(*) DESC;

SELECT COUNT(*) as total_noise FROM public.works WHERE is_noise = true;

-- ---------------------------------------------------------------------------
-- 2. GRANT jel_papers to API roles
-- (Was created as postgres superuser without grants — caused permission denied)
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON public.jel_papers TO iadb_app;
GRANT SELECT, INSERT, UPDATE ON public.jel_papers TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.jel_papers TO authenticated;
GRANT SELECT                  ON public.jel_papers TO anon;

-- ---------------------------------------------------------------------------
-- 3. canonical_work_id — deduplication column
-- NULL  = this IS the canonical version (shown in retrieval)
-- value = ID of the canonical; this row is a shadow (hidden from retrieval)
--
-- Rule: shadow rows are NOT deleted. Their abstract/geography/authors are
-- merged into the canonical before marking them. Evidence cards on shadows
-- stay but the canonical's card takes precedence in briefs.
-- ---------------------------------------------------------------------------

ALTER TABLE public.works
  ADD COLUMN IF NOT EXISTS canonical_work_id text
    REFERENCES public.works(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_works_canonical_work_id
  ON public.works (canonical_work_id)
  WHERE canonical_work_id IS NOT NULL;

COMMENT ON COLUMN public.works.canonical_work_id IS
  'NULL = this is the canonical version shown in retrieval. '
  'Non-null = this is a shadow (duplicate), points to the canonical work. '
  'Set by deduplication migrations; never deleted, always browsable by ID.';
