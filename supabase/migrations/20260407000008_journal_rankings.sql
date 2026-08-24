-- Migration 8: journal rankings lookup tables
-- Purpose: Schema for IDEAS/RePEC and ABS journal quality rankings
-- No RLS — reference/lookup tables readable by all authenticated users
-- Data populated in Phase 3 (Quality) after real ranking data is sourced

create table if not exists public.ideas_repec_rankings (
  id uuid primary key default gen_random_uuid(),
  journal_name text not null,
  repec_handle text,
  percentile numeric,
  rank integer,
  field text,
  created_at timestamptz default now(),
  constraint ideas_repec_rankings_journal_name_unique unique (journal_name)
);

create table if not exists public.abs_rankings (
  id uuid primary key default gen_random_uuid(),
  journal_name text not null,
  abs_rating text,
  field text,
  created_at timestamptz default now(),
  constraint abs_rankings_journal_name_unique unique (journal_name)
);

-- abs_rating values: '4*' | '4' | '3' | '2' | '1' (ABS Academic Journal Guide ratings)

grant select on public.ideas_repec_rankings to authenticated;
grant select on public.abs_rankings to authenticated;
