-- Persist admin-only retrieval audits for regression comparison.
-- Audits compare a search run's evidence table against relaxed expected
-- candidates under the user's selected filters.

create table if not exists public.retrieval_audits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  search_run_id uuid not null references public.search_runs(id) on delete cascade,
  query text not null,
  verdict text not null,
  confidence numeric not null default 0,
  expected_evidence jsonb not null default '[]',
  table_diagnostics jsonb not null default '{}',
  recommended_actions text[] not null default '{}',
  audit_mode text not null default 'corpus',
  external_diagnostics jsonb not null default '{}',
  audit_version text not null default 'retrieval-audit-v1',
  created_at timestamptz not null default now()
);

alter table public.retrieval_audits enable row level security;

drop policy if exists "retrieval_audits: admin select" on public.retrieval_audits;
create policy "retrieval_audits: admin select"
  on public.retrieval_audits
  for select
  using ((select auth.jwt()->'app_metadata'->>'is_admin') = 'true');

create index if not exists retrieval_audits_run_created_idx
  on public.retrieval_audits (search_run_id, created_at desc);

create index if not exists retrieval_audits_user_created_idx
  on public.retrieval_audits (user_id, created_at desc);
