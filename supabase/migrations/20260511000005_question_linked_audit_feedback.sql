-- Link admin audit judgments to the specific question/search run.
-- Positive judgments become admin-expected evidence for future audits of the
-- same normalized question; negative judgments suppress that suggestion only
-- for the same question.

alter table public.retrieval_audit_feedback
  add column if not exists search_run_id uuid references public.search_runs(id) on delete cascade,
  add column if not exists query text,
  add column if not exists query_key text,
  add column if not exists item_year integer,
  add column if not exists item_source text,
  add column if not exists item_authors jsonb not null default '[]',
  add column if not exists item_why_expected text,
  add column if not exists item_status text;

create index if not exists retrieval_audit_feedback_query_key_idx
  on public.retrieval_audit_feedback (query_key, created_at desc);

create unique index if not exists retrieval_audit_feedback_query_doi_verdict_idx
  on public.retrieval_audit_feedback (query_key, lower(item_doi), verdict)
  where item_doi is not null;

create unique index if not exists retrieval_audit_feedback_query_title_verdict_idx
  on public.retrieval_audit_feedback (query_key, lower(item_title), verdict)
  where item_doi is null;
