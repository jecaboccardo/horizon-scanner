-- Separate queue for Tier 2 evidence-card upgrades.
--
-- This intentionally does not reuse extraction_queue. Tier 1 card creation
-- and SMS/design backfill should keep their own throughput; Tier 2 PDF/fuller
-- source extraction can run later with a small worker count and strict limits.

create table if not exists public.evidence_card_upgrade_queue (
  work_id text primary key references public.works(id) on delete cascade,
  evidence_card_id uuid references public.evidence_cards(id) on delete cascade,
  priority_score numeric not null default 0,
  state text not null default 'queued'
    check (state in ('queued', 'processing', 'done', 'failed', 'skipped')),
  target_fields text[] not null default '{}',
  source_hint text not null default 'open_access_pdf',
  reasons text[] not null default '{}',
  attempts integer not null default 0,
  max_attempts integer not null default 2,
  last_error text,
  enqueued_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists evidence_card_upgrade_queue_pending_idx
  on public.evidence_card_upgrade_queue(state, priority_score desc, enqueued_at asc)
  where state = 'queued';

create index if not exists evidence_card_upgrade_queue_processing_idx
  on public.evidence_card_upgrade_queue(state, started_at)
  where state = 'processing';

create index if not exists evidence_card_upgrade_queue_card_idx
  on public.evidence_card_upgrade_queue(evidence_card_id);

create or replace function public.claim_evidence_card_upgrade_batch(batch_size int)
returns setof public.evidence_card_upgrade_queue
language plpgsql
as $$
begin
  return query
  update public.evidence_card_upgrade_queue
  set state = 'processing',
      started_at = now(),
      updated_at = now(),
      attempts = attempts + 1
  where work_id in (
    select work_id
    from public.evidence_card_upgrade_queue
    where (
        state = 'queued'
        or (state = 'processing' and started_at < now() - interval '20 minutes')
      )
      and attempts < max_attempts
    order by priority_score desc, enqueued_at asc
    limit batch_size
    for update skip locked
  )
  returning *;
end;
$$;

alter table public.evidence_card_upgrade_queue enable row level security;

create policy "service_role_all" on public.evidence_card_upgrade_queue
  for all using (auth.role() = 'service_role');

comment on table public.evidence_card_upgrade_queue is
  'Tier 2 queue for upgrading low-confidence evidence cards from PDFs or richer source pages. Separate from extraction_queue so Tier 2 cannot slow Tier 1 card/SMS backfills unless workers are explicitly started.';
