-- Migration: feedback_processed_at
-- Purpose: Track which feedback rows have been consumed by the learning agent.
-- Nullable: null = not yet processed; timestamptz = processed at that time.

alter table public.feedback add column processed_at timestamptz;
