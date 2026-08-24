create table if not exists brief_evals (
  brief_id uuid primary key references briefs(id) on delete cascade,
  claim_grounding_rate numeric,
  ungrounded_claims jsonb,
  latency_phases jsonb,
  persona_consistency_score numeric,
  card_coverage_pct numeric,
  judge_model text,
  evaluated_at timestamptz default now()
);

create index if not exists brief_evals_recent_idx on brief_evals(evaluated_at desc);

alter table brief_evals enable row level security;
create policy "service_role_all" on brief_evals for all using (auth.role() = 'service_role');
