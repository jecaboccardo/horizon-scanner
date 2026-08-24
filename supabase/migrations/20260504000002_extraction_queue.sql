create table if not exists extraction_queue (
  work_id text primary key references works(id) on delete cascade,
  priority_score numeric not null default 0,
  state text not null default 'queued' check (state in ('queued','processing','done','failed')),
  tier integer not null default 1 check (tier in (1,2,3)),
  attempts integer not null default 0,
  last_error text,
  enqueued_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create index if not exists extraction_queue_pending_idx
  on extraction_queue(state, priority_score desc)
  where state = 'queued';

create index if not exists extraction_queue_processing_idx
  on extraction_queue(state, started_at)
  where state = 'processing';

create or replace function claim_extraction_batch(batch_size int)
returns setof extraction_queue
language plpgsql
as $$
begin
  return query
  update extraction_queue
  set state = 'processing',
      started_at = now(),
      attempts = attempts + 1
  where work_id in (
    select work_id from extraction_queue
    where state = 'queued'
       or (state = 'processing' and started_at < now() - interval '10 minutes')
    order by priority_score desc, enqueued_at asc
    limit batch_size
    for update skip locked
  )
  returning *;
end;
$$;

alter table extraction_queue enable row level security;
create policy "service_role_all" on extraction_queue for all using (auth.role() = 'service_role');
