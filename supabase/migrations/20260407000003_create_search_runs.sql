-- Migration 3: search_runs table
-- Purpose: Persists each user's query runs with retrieval results
-- Maps to SearchRun type in types.ts

create table if not exists public.search_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  query text not null,
  filters jsonb not null default '{}',
  intent jsonb,
  candidate_work_ids text[] default '{}',
  evidence_work_ids text[] default '{}',
  signal_work_ids text[] default '{}',
  coverage jsonb,
  retrieval_notes text[] default '{}',
  created_at timestamptz default now()
);

-- Index for query history endpoint — user's runs in reverse chronological order
create index if not exists search_runs_user_created_idx
  on public.search_runs (user_id, created_at desc);
