create table if not exists worker_heartbeat (
  worker_id text primary key,
  last_seen timestamptz not null default now(),
  hostname text,
  pid integer,
  metadata jsonb
);

alter table worker_heartbeat enable row level security;
create policy "service_role_all" on worker_heartbeat for all using (auth.role() = 'service_role');
