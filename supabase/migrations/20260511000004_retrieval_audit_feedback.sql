-- Admin corrections for retrieval audit suggestions.
-- Used to suppress expected-evidence suggestions that admins mark as not relevant.

create table if not exists public.retrieval_audit_feedback (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references public.retrieval_audits(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  item_title text not null,
  item_doi text,
  verdict text not null check (verdict in ('not_relevant', 'relevant')),
  note text,
  created_at timestamptz not null default now()
);

alter table public.retrieval_audit_feedback enable row level security;

drop policy if exists "retrieval_audit_feedback: admin select" on public.retrieval_audit_feedback;
create policy "retrieval_audit_feedback: admin select"
  on public.retrieval_audit_feedback
  for select
  using ((select auth.jwt()->'app_metadata'->>'is_admin') = 'true');

create index if not exists retrieval_audit_feedback_audit_idx
  on public.retrieval_audit_feedback (audit_id, created_at desc);

create index if not exists retrieval_audit_feedback_doi_idx
  on public.retrieval_audit_feedback (lower(item_doi))
  where item_doi is not null;

create index if not exists retrieval_audit_feedback_title_idx
  on public.retrieval_audit_feedback (lower(item_title));
