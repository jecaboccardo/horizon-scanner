-- Phase 6 (AUDIT-02): Add classification rationale columns to works table
-- Stores WHY each paper received its SMS level and journal ranking match

ALTER TABLE works
  ADD COLUMN IF NOT EXISTS sms_rationale TEXT,
  ADD COLUMN IF NOT EXISTS journal_match_info JSONB DEFAULT '{}'::jsonb;

-- sms_rationale: human-readable explanation, e.g. "Classified SMS 4 because abstract contains 'difference-in-differences'"
-- journal_match_info: { matchType, matchedJournal, absField, repecTotalCount }
