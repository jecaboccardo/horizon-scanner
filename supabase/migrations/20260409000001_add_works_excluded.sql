-- Add excluded column to works table
-- Purpose: Allow admins to exclude specific papers from future search results
ALTER TABLE public.works ADD COLUMN IF NOT EXISTS excluded boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_works_excluded ON public.works (excluded) WHERE excluded = true;
