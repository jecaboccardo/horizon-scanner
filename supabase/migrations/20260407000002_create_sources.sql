-- Migration 2: sources table
-- Purpose: Global reference data for academic/institutional sources with credibility tiers
-- No RLS — lookup table readable by all authenticated users

create table if not exists public.sources (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  source_type text not null,
  credibility_tier text not null,
  coverage_type text not null,
  license_access text not null default 'open',
  allowed_use text not null default 'evidence',
  homepage text,
  created_at timestamptz default now()
);

-- source_type values: 'institutional' | 'journal' | 'repository' | 'social' | 'manual'
-- credibility_tier values: 'Tier A' | 'Tier B' | 'Tier C' (matches types.ts SourceCredibilityTier)
-- coverage_type values: 'scholarly' | 'gray-literature' | 'signal'
-- license_access values: 'open' | 'restricted' | 'unknown'
-- allowed_use values: 'evidence' | 'signal' | 'restricted'

grant select on public.sources to authenticated;
