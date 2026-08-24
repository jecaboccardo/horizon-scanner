-- Migration: expand abs_rankings with ISSN, publisher, and historical ratings
-- Data scraped from journalranking.org (ABS Academic Journal Guide 2024)

alter table public.abs_rankings
  add column if not exists issn text,
  add column if not exists publisher text,
  add column if not exists ajg2021 text,
  add column if not exists ajg2018 text;

-- Add ISSN uniqueness (some journals may share ISSNs, so not strictly unique — use index instead)
create index if not exists idx_abs_rankings_issn on public.abs_rankings(issn);
