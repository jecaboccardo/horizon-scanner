create table if not exists extraction_issues (
  id uuid primary key default gen_random_uuid(),
  work_id text not null references works(id),
  card_id uuid references evidence_cards(id),
  issue_type text not null check (issue_type in (
    'verification_failed','parse_error','timeout','thin_abstract','low_confidence','pdf_fetch_failed'
  )),
  details jsonb,
  created_at timestamptz default now()
);

create index if not exists extraction_issues_work_id_idx on extraction_issues(work_id);
create index if not exists extraction_issues_type_idx on extraction_issues(issue_type);
create index if not exists extraction_issues_recent_idx on extraction_issues(created_at desc);

alter table extraction_issues enable row level security;
create policy "service_role_all" on extraction_issues for all using (auth.role() = 'service_role');
