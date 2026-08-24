-- Migration: expand ideas_repec_rankings with score, items, sub-metrics
-- Data scraped from ideas.repec.org aggregate journal rankings

alter table public.ideas_repec_rankings
  add column if not exists score numeric,
  add column if not exists items_listed integer,
  add column if not exists simple_if_rank integer,
  add column if not exists recursive_if_rank integer,
  add column if not exists h_index_rank integer,
  add column if not exists publisher text;

-- Drop old repec_handle column if unused (it was speculative)
-- Keep it for now — might be useful for linking to RePEC pages later
