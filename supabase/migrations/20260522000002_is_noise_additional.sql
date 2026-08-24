-- Migration: additional noise patterns missed in 20260522000001
-- Applied directly to DB on 2026-05-22; this documents what was run.
--
-- Catches: [no title] entries, DISCUSSION/Announcement/Editorial data
-- (Journal of Finance AFA meeting discussions, APSR no-title entries,
--  Journal of Financial Economics data pages, etc.) — 1,167 papers.
-- Also deletes 3 canonical_doi duplicates (IDB papers ingested twice).
-- Also enqueues 368 high-citation papers with abstracts but no SMS.

-- Additional generic section headers missed by exact-match list
UPDATE public.works SET is_noise = true, noise_reason = 'generic_section_header'
WHERE is_noise = false AND title IN (
  '[no title]', 'DISCUSSION', 'Announcement', 'Editorial data'
);

-- DOI duplicates: IDB papers ingested twice (keep canonical DOI version)
DELETE FROM public.works
WHERE id IN (
  'idb:a700e484-81e2-41a3-9225-52e317363700',
  'idb:1b543eb2-7c2f-4965-ad28-5b8de3f0f49e'
);

-- Third duplicate: keep whichever row has more data
DELETE FROM public.works w
WHERE canonical_doi = '10.18235/0007491'
  AND id IN (
    SELECT id FROM works
    WHERE canonical_doi = '10.18235/0007491'
    ORDER BY (abstract IS NULL) DESC, created_at ASC
    LIMIT 1
  )
  AND (SELECT COUNT(*) FROM works WHERE canonical_doi = '10.18235/0007491') > 1;

-- Enqueue papers that have abstracts but no SMS/methodology yet
-- (keyword scan ran but couldn't classify; Qwen hasn't touched them)
-- Priority 70 so they run after the SMS-3-5 priority papers
INSERT INTO public.extraction_queue (work_id, priority_score, state, attempts)
SELECT w.id, 70, 'queued', 0
FROM works w
LEFT JOIN extraction_queue eq ON eq.work_id = w.id
WHERE w.sms_level IS NULL
  AND w.methodology_design IS NULL
  AND w.abstract IS NOT NULL
  AND w.is_noise = false
  AND eq.work_id IS NULL
ON CONFLICT (work_id) DO NOTHING;

-- Remove newly flagged noise from extraction queue
DELETE FROM public.extraction_queue eq
USING public.works w
WHERE eq.work_id = w.id
  AND w.is_noise = true
  AND eq.state != 'done';
