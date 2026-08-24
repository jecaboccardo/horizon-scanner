-- Migration: paper_plans foundation
-- Adds an editable "planning" phase to jel_papers: a seeded plan (question +
-- curated evidence + emphasis) that later drives generation, plus a
-- regeneration counter for the post-draft "talk-to-it" cap (2 per paper).

ALTER TABLE public.jel_papers
  ADD COLUMN IF NOT EXISTS plan jsonb,
  ADD COLUMN IF NOT EXISTS regenerations_used integer NOT NULL DEFAULT 0;

-- Extend the status lifecycle to include 'planning' (precedes 'queued').
ALTER TABLE public.jel_papers DROP CONSTRAINT IF EXISTS jel_papers_status_check;
ALTER TABLE public.jel_papers ADD CONSTRAINT jel_papers_status_check
  CHECK (status IN ('planning', 'queued', 'running', 'done', 'error'));

COMMENT ON COLUMN public.jel_papers.plan IS
  'Editable paper plan during status=planning: workingQuestion, scope, '
  'curatedWorkIds, removedWorkIds, uploads, emphasis, outlinePreview.';
