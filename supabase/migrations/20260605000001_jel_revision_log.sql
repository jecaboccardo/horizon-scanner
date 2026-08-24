-- Revision history for JEL papers ("talk-to-the-draft" thread).
-- Appended on each SUCCESSFUL revision. Written fail-safe by the API, so a lag
-- between deploy and migration never breaks revision; absent on legacy papers.
ALTER TABLE public.jel_papers
  ADD COLUMN IF NOT EXISTS revision_log jsonb NOT NULL DEFAULT '[]'::jsonb;
