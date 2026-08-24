-- Migration: add journal name and ranking score columns to works
-- Used by QUAL-02 (RePEC) and QUAL-03 (ABS) journal ranking lookup

alter table public.works
  add column if not exists venue text,
  add column if not exists journal_issn text,
  add column if not exists abs_rating text,
  add column if not exists repec_rank integer,
  add column if not exists repec_percentile numeric;

-- abs_rating: '4*' | '4' | '3' | '2' | '1' | null (no match)
-- repec_rank: 1-3387 (lower = better) | null (no match)
-- repec_percentile: 0-100 (higher = better) | null (no match)

create index if not exists idx_works_venue on public.works(venue) where venue is not null;
