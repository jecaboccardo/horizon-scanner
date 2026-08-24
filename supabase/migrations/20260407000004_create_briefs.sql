-- Migration 4: briefs table
-- Purpose: Persists structured evidence briefs generated from search runs
-- Maps to EvidenceBrief type in types.ts

create table if not exists public.briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  search_run_id uuid references public.search_runs(id) on delete set null,
  query text not null,
  status text not null default 'draft',
  sections jsonb not null default '{}',
  audit_trace jsonb,
  share_path text,
  created_at timestamptz default now()
);

-- status values: 'draft' | 'ready' | 'error' (matches types.ts BriefStatus)
-- sections stores EvidenceBriefSections shape as jsonb
-- audit_trace stores AuditTrace shape as jsonb
-- share_path: /briefs/<id> — share-by-link pattern; the UUID itself is the access token

create index if not exists briefs_user_created_idx
  on public.briefs (user_id, created_at desc);
